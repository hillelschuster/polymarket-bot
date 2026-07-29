// Minimal live execution for Lane A wallet-copy trades.
// ONE path: same approved quote -> exact-share FOK -> hold to resolution.
import { prisma } from "./db.js";
import { executeFokBuy } from "../adapters/execution.js";
import { assertLiveTradingConfigured, config } from "./config.js";

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

  const openExposure = await prisma.liveOrder.aggregate({
    where: { status: "open" },
    _sum: { quoteCashCost: true },
  });
  if ((openExposure._sum.quoteCashCost ?? 0) + cashBudget > config.LIVE_MAX_TOTAL_EXPOSURE_USD) {
    await prisma.liveOrder.create({
      data: {
        decisionJournalId, walletAddress, marketId, slug, tokenId, side: "BUY",
        cashBudget, paperAllInPrice: allInPrice, shares, status: "blocked_cap",
        error: `exposure cap $${config.LIVE_MAX_TOTAL_EXPOSURE_USD} reached`,
      },
    }).catch((err: unknown) => {
      if ((err as { code?: string }).code !== "P2002") throw err;
    });
    return;
  }

  // Persist intent before any network request. @unique prevents restart duplicates.
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
