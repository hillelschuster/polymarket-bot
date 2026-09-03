// Minimal live execution for Lane A wallet-copy trades.
// ONE path: same approved quote -> exact-share FOK -> hold to resolution.
import { prisma } from "./db.js";
import { getMarketBySlug } from "../adapters/polymarket.js";
import { assertLiveTradingConfigured, config } from "./config.js";
import { liveLimitReason } from "./liveLimits.js";
import { isBaseballMarket } from "./scoring.js";

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

  // Hard gate: baseball is disabled for live execution (negative EV, market-maker adverse selection).
  if (isBaseballMarket(slug, null)) {
    console.log(`executeWalletCopyOrder: rejected baseball slug ${slug} (live baseball disabled)`);
    return;
  }

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
    const allowanceUsd = allowances.length > 0 ? Math.max(...allowances) : 0;
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
  // 1. Reconcile stale "unknown" or "submitted" orders older than 2 minutes against CLOB
  try {
    const stuckOrders = await prisma.liveOrder.findMany({
      where: {
        status: { in: ["unknown", "submitted"] },
        createdAt: { lt: new Date(Date.now() - 2 * 60 * 1000) },
      },
    });
    if (stuckOrders.length > 0) {
      const { getTradingClient } = await import("../adapters/execution.js");
      const trading = getTradingClient();

      for (const stuck of stuckOrders) {
        try {
          if (stuck.orderId) {
            // Case A: Query exchange for order status by orderId
            const clobOrder = await trading.getOrder(stuck.orderId);
            const matchedSize = Number(clobOrder.size_matched ?? 0);
            const orderStatus = String(clobOrder.status ?? "").toUpperCase();

            if (orderStatus === "MATCHED" || (matchedSize > 0 && matchedSize >= Number(clobOrder.original_size ?? 0))) {
              await prisma.liveOrder.update({
                where: { id: stuck.id },
                data: {
                  status: "open",
                  orderState: "matched",
                  shares: matchedSize || stuck.shares,
                  filledAt: new Date(),
                  error: null,
                },
              });
              console.log(`LiveOrder ${stuck.id}: reconciled orderId ${stuck.orderId} -> open (${matchedSize} shares)`);
            } else if (["CANCELLED", "CANCELED", "FAILED", "REJECTED", "UNMATCHED"].includes(orderStatus) && matchedSize === 0) {
              await prisma.liveOrder.update({
                where: { id: stuck.id },
                data: {
                  status: "not_filled",
                  orderState: "failed",
                  error: `FOK order ${orderStatus.toLowerCase()} on CLOB`,
                },
              });
              console.log(`LiveOrder ${stuck.id}: reconciled orderId ${stuck.orderId} -> not_filled (${orderStatus})`);
            }
          } else if (stuck.tokenId) {
            // Case B: Order has no orderId — verify against authenticated user trade history
            const trades = await trading.getTrades({ asset_id: stuck.tokenId }).catch(() => []);
            const windowStart = stuck.createdAt.getTime() - 10_000;
            const windowEnd = stuck.createdAt.getTime() + 90_000;

            const matched = (trades as Array<{ match_time?: string; timestamp?: string; status?: string; size?: string | number; taker_order_id?: string; transaction_hash?: string }>).filter((t) => {
              const matchTs = new Date(t.match_time || t.timestamp || 0).getTime();
              return matchTs >= windowStart && matchTs <= windowEnd && String(t.status).toUpperCase() === "MATCHED";
            });

            if (matched.length > 0) {
              const filledShares = matched.reduce((acc, t) => acc + Number(t.size ?? 0), 0);
              const txHash = matched.find((t) => t.transaction_hash)?.transaction_hash ?? null;
              await prisma.liveOrder.update({
                where: { id: stuck.id },
                data: {
                  status: "open",
                  orderState: "matched",
                  shares: filledShares || stuck.shares,
                  orderId: matched[0]?.taker_order_id || null,
                  transactionHash: txHash,
                  filledAt: new Date(matched[0]?.match_time || stuck.createdAt),
                  error: null,
                },
              });
              console.log(`LiveOrder ${stuck.id}: verified fill in trade history -> open (${filledShares} shares)`);
            } else {
              await prisma.liveOrder.update({
                where: { id: stuck.id },
                data: { status: "not_filled", error: "stale submission without orderId verified 0 fills on CLOB" },
              });
              console.log(`LiveOrder ${stuck.id}: verified 0 fills in trade history -> not_filled`);
            }
          }
        } catch (itemErr) {
          console.warn(`LiveOrder ${stuck.id}: reconciliation check skipped: ${(itemErr as Error).message}`);
        }
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
