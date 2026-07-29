// Resolve paper trades only after Gamma marks the market officially closed.
import { prisma } from "../lib/db.js";
import { resolvePaperTrade } from "../lib/paper.js";
import { getMarketBySlug } from "../adapters/polymarket.js";
import { isLive } from "../lib/config.js";

const RESOLVED_EPS = 0.005;

export async function runReviewOutcomes(): Promise<void> {
  if (!isLive) {
    console.log("DEMO mode: skipping outcome review (seed provides reviews)");
    return;
  }

  const open = await prisma.paperTrade.findMany({
    where: { status: "open" },
    include: { decisionJournal: { include: { observedTrade: true } } },
  });
  if (!open.length) {
    console.log("reviewOutcomes: no open paper trades");
    return;
  }

  const bySlug = new Map<string, typeof open>();
  for (const pt of open) {
    if (!pt.slug) continue;
    const arr = bySlug.get(pt.slug) ?? [];
    arr.push(pt);
    bySlug.set(pt.slug, arr);
  }

  let resolved = 0;
  for (const [slug, trades] of bySlug) {
    let market: Awaited<ReturnType<typeof getMarketBySlug>>;
    try {
      market = await getMarketBySlug(slug);
    } catch (e) {
      console.warn(`reviewOutcomes: getMarketBySlug failed for ${slug}: ${(e as Error).message}`);
      continue;
    }
    if (!market || !market.closed) continue;

    const terminal = market.outcomePrices.every((p) => Number.isFinite(p) && (p <= RESOLVED_EPS || p >= 1 - RESOLVED_EPS));
    if (!terminal) continue;

    await prisma.marketSnapshot.create({
      data: {
        marketId: trades[0].marketId,
        conditionId: trades[0].decisionJournal?.observedTrade?.conditionId ?? market.conditionId,
        slug,
        question: market.question,
        category: market.category,
        yesPrice: market.outcomePrices[0] ?? null,
        noPrice: market.outcomePrices[1] ?? null,
        spread: market.spread,
        liquidity: market.liquidity,
        rawMarketJson: JSON.stringify(market),
      },
    });

    for (const pt of trades) {
      let tokenIndex = pt.tokenId ? market.clobTokenIds.indexOf(pt.tokenId) : -1;
      if (tokenIndex < 0 && pt.outcome) {
        tokenIndex = market.outcomes.findIndex((x) => x.toLowerCase() === pt.outcome!.toLowerCase());
      }
      if (tokenIndex < 0) continue;

      const settlementPrice = market.outcomePrices[tokenIndex];
      if (!Number.isFinite(settlementPrice)) continue;
      const won = settlementPrice >= 1 - RESOLVED_EPS;
      const updated = resolvePaperTrade(
        {
          walletAddress: pt.walletAddress,
          marketId: pt.marketId,
          outcome: pt.outcome ?? market.outcomes[tokenIndex] ?? "YES",
          side: pt.side ?? "BUY",
          entryPrice: pt.entryPrice ?? 0.5,
          simulatedPositionSize: pt.simulatedPositionSize ?? 10,
          status: "open",
          currentPrice: pt.currentPrice ?? pt.entryPrice ?? 0.5,
          unrealizedPnl: pt.unrealizedPnl ?? 0,
          realizedPnl: null,
          openedAt: pt.openedAt.getTime(),
          closedAt: null,
          resolvedAt: null,
        },
        won ? "win" : "lose",
      );

      await prisma.paperTrade.update({
        where: { id: pt.id },
        data: {
          status: "resolved",
          currentPrice: won ? 1 : 0,
          realizedPnl: updated.realizedPnl,
          unrealizedPnl: 0,
          closedAt: new Date(updated.closedAt!),
          resolvedAt: new Date(updated.resolvedAt!),
        },
      });

      // A real wallet-copy position has the same binary settlement as its
      // paper decision. Mark it resolved so its cash no longer counts toward
      // the live exposure cap and retain realized execution PnL for review.
      if (pt.decisionJournal) {
        const live = await prisma.liveOrder.findUnique({
          where: { decisionJournalId: pt.decisionJournal.id },
        });
        if (live?.status === "open") {
          const realizedPnl = (live.shares ?? 0) * settlementPrice
            - (live.quoteCashCost ?? live.cashBudget ?? 0);
          await prisma.liveOrder.update({
            where: { id: live.id },
            data: { status: "resolved", resolvedAt: new Date(), realizedPnl },
          });
        }
      }

      if (pt.decisionJournal) {
        await prisma.outcomeReview.create({
          data: {
            decisionJournalId: pt.decisionJournal.id,
            paperTradeId: pt.id,
            finalOutcome: won ? 1 : 0,
            simulatedPnl: updated.realizedPnl,
            wasDecisionGood: (updated.realizedPnl ?? 0) > 0,
            priceAfter1h: settlementPrice,
            priceAfter6h: settlementPrice,
            priceAfter24h: settlementPrice,
          },
        });
      }
      resolved++;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(`reviewOutcomes done: ${resolved} trades resolved`);
}

if (require.main === module) runReviewOutcomes().catch(console.error);
