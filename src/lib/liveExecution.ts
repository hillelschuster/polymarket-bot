// Minimal live execution for Lane A wallet-copy trades.
// ONE path: same approved quote -> exact-share FOK -> hold to resolution.
import { prisma } from "./db.js";
import { getMarketBySlug } from "../adapters/polymarket.js";
import { assertLiveTradingConfigured, config } from "./config.js";
import { liveLimitReason } from "./liveLimits.js";

function atomicUsd(value: string | number): number {
  if (String(value).toLowerCase() === "unlimited") return Infinity;
  const raw = Number(value);
  return Number.isFinite(raw) ? raw / 1_000_000 : NaN;
}

/**
 * Execute ONE FOK buy for a wallet-copy signal.
 * Call ONLY after paper trade is saved. Never retried; never re-derived.
 * An ambiguous submit is persisted and blocks all future live orders.
 */
export async function executeWalletCopyOrder(params: {
  tokenId: string;
  cashBudget: number;   // USDC to spend (including fees)
  allInPrice: number;   // paper quote's max all-in price per share
  shares: number;       // expected shares (for audit)
  decisionJournalId: string;
  walletAddress: string;
  marketId: string;
  slug: string | null;
}): Promise<void> {
  const { tokenId, cashBudget, allInPrice, shares, decisionJournalId, walletAddress, marketId, slug } = params;

  // Do not create a durable intent if the live switch/credentials are invalid.
  assertLiveTradingConfigured();

  // A previous ambiguous request may have filled. Do not risk a second order.
  const blocker = await prisma.liveOrder.findFirst({
    where: { status: { in: ["unknown", "submitted"] } },
  });
  if (blocker) {
    throw new Error(
      `Live orders blocked: unresolved order ${blocker.id} (status: ${blocker.status}). ` +
      `Manual review required before new live orders.`,
    );
  }

  const openOrders = await prisma.liveOrder.findMany({
    where: { status: "open" },
    select: { quoteCashCost: true, cashBudget: true },
  });
  const limitReason = liveLimitReason({
    openPositions: openOrders.length,
    exposureUsd: openOrders.reduce((sum, order) => sum + (order.quoteCashCost ?? order.cashBudget ?? 0), 0),
    cashBudget,
  }, {
    maxOpenPositions: config.LIVE_MAX_OPEN_POSITIONS,
    maxPositionUsd: config.LIVE_MAX_POSITION_USD,
    maxExposureUsd: config.LIVE_MAX_TOTAL_EXPOSURE_USD,
  });
  if (limitReason) {
    await prisma.liveOrder.create({
      data: {
        decisionJournalId, walletAddress, marketId, slug, tokenId, side: "BUY",
        cashBudget, paperAllInPrice: allInPrice, shares, status: "blocked_cap",
        error: limitReason,
      },
    }).catch((err: unknown) => {
      if ((err as { code?: string }).code !== "P2002") throw err;
    });
    return;
  }

  // Refresh the CLOB cache and fail closed if the actual collateral cannot fund this order.
  const [{ AssetType }, { executeFokBuy, getTradingClient }] = await Promise.all([
    import("@polymarket/clob-client-v2"),
    import("../adapters/execution.js"),
  ]);
  const trading = getTradingClient();
  try {
    await trading.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const collateral = await trading.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const balanceUsd = atomicUsd(collateral.balance);
    const allowances = Object.values(collateral.allowances ?? {}).map(atomicUsd);
    const allowanceUsd = allowances.length > 0 ? Math.min(...allowances) : 0;
    if (!Number.isFinite(balanceUsd) || balanceUsd + 0.005 < cashBudget || allowanceUsd + 0.005 < cashBudget) {
      await prisma.liveOrder.create({
        data: {
          decisionJournalId, walletAddress, marketId, slug, tokenId, side: "BUY",
          cashBudget, paperAllInPrice: allInPrice, shares, status: "blocked_balance",
          error: `collateral preflight failed (balance=$${balanceUsd}, allowance=$${allowanceUsd})`,
        },
      }).catch((err: unknown) => {
        if ((err as { code?: string }).code !== "P2002") throw err;
      });
      return;
    }
  } catch (err) {
    await prisma.liveOrder.create({
      data: {
        decisionJournalId, walletAddress, marketId, slug, tokenId, side: "BUY",
        cashBudget, paperAllInPrice: allInPrice, shares, status: "blocked_balance",
        error: `collateral preflight error: ${(err as Error).message}`,
      },
    }).catch((createErr: unknown) => {
      if ((createErr as { code?: string }).code !== "P2002") throw createErr;
    });
    return;
  }

  // Persist intent before the FOK network request. @unique prevents restart duplicates.
  let lo;
  try {
    lo = await prisma.liveOrder.create({
      data: {
        decisionJournalId, walletAddress, marketId, slug, tokenId, side: "BUY",
        cashBudget, paperAllInPrice: allInPrice, shares, status: "submitted",
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return;
    throw err;
  }

  const result = await executeFokBuy({
    tokenId,
    shares,
    maxCashCost: cashBudget,
    maxAllInPrice: allInPrice,
  });
  const response = result.response;
  const quote = result.prepared?.quote;
  const status = result.status === "filled"
    ? "open"
    : result.status === "not_filled" ? "not_filled" : "unknown";
  await prisma.liveOrder.update({
    where: { id: lo.id },
    data: {
      status,
      shares: result.prepared?.leg.shares ?? lo.shares,
      orderState: result.state ?? null,
      quoteCashCost: quote?.cashCost,
      quoteAllInPrice: quote?.allInPrice,
      quoteFee: quote?.fee,
      limitPrice: result.prepared?.leg.limitPrice,
      orderId: response?.orderID || null,
      transactionHash: response?.transactionsHashes?.[0] || null,
      responseJson: response ? JSON.stringify(response) : null,
      error: result.error ?? null,
      filledAt: status === "open" ? new Date() : null,
    },
  });
  console.log(`LiveOrder ${lo.id}: ${status}${result.error ? ` — ${result.error}` : ""}`);
}

/** Mark held wallet-copy positions resolved once Gamma reports a binary payout, and reconcile stuck orders. */
export async function reconcileLiveOrders(): Promise<void> {
  // 1. Auto-unblock stale "unknown" or "submitted" orders older than 2 minutes without orderId
  try {
    const stuckOrders = await prisma.liveOrder.findMany({
      where: {
        status: { in: ["unknown", "submitted"] },
        createdAt: { lt: new Date(Date.now() - 2 * 60 * 1000) },
      },
    });
    for (const stuck of stuckOrders) {
      if (!stuck.orderId) {
        await prisma.liveOrder.update({
          where: { id: stuck.id },
          data: { status: "not_filled", error: "stale submission without orderId auto-unblocked" },
        });
        console.log(`LiveOrder ${stuck.id}: auto-unblocked stale ${stuck.status} -> not_filled`);
      }
    }
  } catch (e) {
    console.warn(`reconcileLiveOrders: stuck order check failed: ${(e as Error).message}`);
  }

  // 2. Reconcile resolved open orders
  const openOrders = await prisma.liveOrder.findMany({
    where: { status: "open" },
    select: {
      id: true,
      slug: true,
      tokenId: true,
      shares: true,
      quoteCashCost: true,
    },
  });

  for (const order of openOrders) {
    if (!order.slug || !order.tokenId || order.shares == null || order.quoteCashCost == null) continue;
    try {
      const market = await getMarketBySlug(order.slug);
      if (!market?.closed) continue;
      const tokenIndex = market.clobTokenIds?.findIndex((id) => id === order.tokenId) ?? -1;
      const finalPrice = tokenIndex >= 0 ? Number(market.outcomePrices?.[tokenIndex]) : NaN;
      if (finalPrice !== 0 && finalPrice !== 1) continue;

      await prisma.liveOrder.update({
        where: { id: order.id },
        data: {
          status: "resolved",
          resolvedAt: new Date(),
          realizedPnl: order.shares * finalPrice - order.quoteCashCost,
        },
      });
      console.log(`LiveOrder ${order.id}: resolved at ${finalPrice}`);
    } catch (err) {
      console.warn(`LiveOrder ${order.id}: reconciliation skipped — ${(err as Error).message}`);
    }
  }
}
