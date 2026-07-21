// Job: review:outcomes. Refresh market state for open paper trades, resolve on resolution. SPEC §10.
import { prisma } from "../lib/db.js";
import { resolvePaperTrade } from "../lib/paper.js";
import { getMarketBySlug } from "../adapters/polymarket.js";
import { isLive } from "../lib/config.js";

const RESOLVED_EPS = 0.005; // a binary outcome at ~0 or ~1 is resolved

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
  // Dedupe by slug so we hit the API once per market, not per trade.
  const bySlug = new Map<string, typeof open>();
  for (const pt of open) {
    const slug = pt.slug;
    if (!slug) continue;
    const arr = bySlug.get(slug) ?? [];
    arr.push(pt);
    bySlug.set(slug, arr);
  }
  let resolved = 0;
  for (const [slug, pts] of bySlug) {
    // Prefer a stored terminal snapshot (reliable; live gamma fetch is rate-limited
    // and often returns null). Fall back to a live fetch only if no snapshot exists.
    const snap = await prisma.marketSnapshot.findFirst({
      where: { slug, OR: [{ yesPrice: { lte: RESOLVED_EPS } }, { yesPrice: { gte: 1 - RESOLVED_EPS } }] },
    });
    let yesFinal: number | null = null;
    let question = "";
    let category: string | null = null;
    let spread: number | null = null;
    let liquidity: number | null = null;
    if (snap && snap.yesPrice != null) {
      yesFinal = snap.yesPrice;
      question = snap.question ?? "";
      category = snap.category;
      spread = snap.spread;
      liquidity = snap.liquidity;
    } else {
      let mkt: Awaited<ReturnType<typeof getMarketBySlug>> = null;
      try {
        mkt = await getMarketBySlug(slug);
      } catch (e) {
        console.warn(`reviewOutcomes: getMarketBySlug failed for ${slug}: ${(e as Error).message}`);
        continue;
      }
      if (!mkt) continue;
      yesFinal = Number(mkt.outcomePrices[0]); // YES outcome price
      question = mkt.question ?? "";
      category = mkt.category;
      spread = mkt.spread;
      liquidity = mkt.liquidity;
      await prisma.marketSnapshot.create({
        data: {
          marketId: pts[0].marketId,
          conditionId: pts[0].decisionJournal?.observedTrade?.conditionId ?? null,
          slug,
          question,
          category,
      yesPrice: yesFinal ?? null,
      noPrice: Number(mkt.outcomePrices[1]) ?? null,
          spread,
          liquidity,
          rawMarketJson: JSON.stringify(mkt),
        },
      });
    }
    if (yesFinal == null || Number.isNaN(yesFinal)) continue;
    // Resolution = terminal YES price (~0 or ~1). gamma endDate is often null,
    // so we detect on price alone (pre-resolution favorites rarely exceed 0.995).
    const isResolved = yesFinal >= 1 - RESOLVED_EPS || yesFinal <= RESOLVED_EPS;
    if (!isResolved) continue;
    for (const pt of pts) {
      // BUY (YES) wins if YES resolves to 1; SELL (NO) wins if YES resolves to 0.
      const won = pt.side === "SELL" ? yesFinal <= RESOLVED_EPS : yesFinal >= 1 - RESOLVED_EPS;
      const updated = resolvePaperTrade(
        {
          walletAddress: pt.walletAddress,
          marketId: pt.marketId,
          outcome: pt.outcome ?? "YES",
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
          status: updated.status,
          realizedPnl: updated.realizedPnl,
          unrealizedPnl: 0,
          resolvedAt: new Date(updated.resolvedAt!),
        },
      });
      if (pt.decisionJournal) {
        await prisma.outcomeReview.create({
          data: {
            decisionJournalId: pt.decisionJournal.id,
            paperTradeId: pt.id,
            finalOutcome: won ? 1 : 0,
            simulatedPnl: updated.realizedPnl,
            wasDecisionGood: (updated.realizedPnl ?? 0) > 0,
            priceAfter1h: yesFinal,
            priceAfter6h: yesFinal,
            priceAfter24h: yesFinal,
          },
        });
        resolved++;
      }
    }
    await new Promise((r) => setTimeout(r, 120)); // respect gamma rate limits
  }
  console.log(`reviewOutcomes done: ${resolved} trades resolved`);
}

if (require.main === module) runReviewOutcomes().catch(console.error);
