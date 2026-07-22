// Job: score:trades. Score new trades -> DecisionJournal (+ PaperTrade on copy). SPEC §10.
import { prisma } from "../lib/db.js";
import { scoreTrade, DEFAULT_RULES, walletCopySkipReason, categoryFromSlug, type TradeInput } from "../lib/scoring.js";
import { createPaperTrade } from "../lib/paper.js";
import { getMarketBySlug, getExecutableBuyQuote } from "../adapters/polymarket.js";

/**
 * Parse resolution date from sports slugs like "mlb-wsh-col-2026-07-21".
 * Returns days from now until end-of-game-day (assumes games end by 05:00 UTC next day).
 * Falls back to 30 days if no date found in slug.
 */
function daysToResolutionFromSlug(slug: string | null): number {
  if (!slug) return 30;
  const match = slug.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) return 30;
  // Sports games on date X resolve by ~05:00 UTC on X+1
  const gameDate = new Date(match[1] + "T05:00:00Z");
  gameDate.setDate(gameDate.getDate() + 1);
  return (gameDate.getTime() - Date.now()) / 86_400_000;
}

export async function runScoreTrades(): Promise<void> {
  // Use the active (self-improved) ruleset so updateRules' learning actually reaches
  // scoring. Fall back to DEFAULT_RULES if none exists yet.
  const activeRs = await prisma.ruleSet.findFirst({ where: { active: true }, orderBy: { version: "desc" } });
  let rules = DEFAULT_RULES;
  if (activeRs) {
    try {
      // Merge with defaults so older RuleSet versions missing newer fields don't produce undefined.
      rules = { ...DEFAULT_RULES, ...JSON.parse(activeRs.rulesJson) };
    } catch {
      console.warn("scoreTrades: malformed rulesJson, falling back to DEFAULT_RULES");
    }
  }

  const unscored = await prisma.observedTrade.findMany({
    where: { decision: null },
    include: { wallet: true },
    take: 100,
  });
  if (!unscored.length) {
    console.log("scoreTrades: no unscored trades found");
    return;
  }

  // Fetch current market state once per slug (deduped) so we can compute the live
  // price of the wallet's exact outcome token (via clobTokenIds) and the movement
  // since the wallet's entry — this is what lets us avoid late entries / buying tops.
  const bySlug = new Map<string, typeof unscored>();
  for (const ot of unscored) {
    if (!ot.slug) continue;
    const arr = bySlug.get(ot.slug) ?? [];
    arr.push(ot);
    bySlug.set(ot.slug, arr);
  }
  const mktBySlug = new Map<string, Awaited<ReturnType<typeof getMarketBySlug>>>();
  for (const [slug] of bySlug) {
    try {
      mktBySlug.set(slug, await getMarketBySlug(slug));
    } catch {
      /* skip */
    }
    await new Promise((r) => setTimeout(r, 120)); // gamma rate limit
  }

  // Per-(wallet, side) copy track record — the real "leverage good wallets" signal.
  // Wallet global score does NOT predict trade profitability (verified live: 40–50 global
  // wallets lose too), and BUY loses while SELL wins, so we track each (wallet, side)
  // pair separately and only keep the ones that have actually made us money.
  // One query for all copies, then aggregate in memory (fast, no N+1).
  const allCopies = await prisma.paperTrade.findMany({
    select: { walletAddress: true, side: true, unrealizedPnl: true, realizedPnl: true, status: true },
  });
  const copyPerf = new Map<string, { count: number; winRate: number; avgPnl: number; wins: number }>();
  const walletTotalPnl = new Map<string, number>();
  const walletOpenCount = new Map<string, number>();
  for (const c of allCopies) {
    const side = c.side ?? "BUY";
    const pnl = c.status !== "open" ? (c.realizedPnl ?? 0) : (c.unrealizedPnl ?? 0);
    const k = `${c.walletAddress}|${side}`;
    const e = copyPerf.get(k) ?? { count: 0, winRate: 0, avgPnl: 0, wins: 0 };
    e.count++;
    e.avgPnl += pnl;
    if (pnl > 0) e.wins++;
    copyPerf.set(k, e);
    walletTotalPnl.set(c.walletAddress, (walletTotalPnl.get(c.walletAddress) ?? 0) + pnl);
    if (c.status === "open") walletOpenCount.set(c.walletAddress, (walletOpenCount.get(c.walletAddress) ?? 0) + 1);
  }
  for (const e of copyPerf.values()) {
    e.avgPnl /= e.count;
    e.winRate = e.wins / e.count;
  }

  const priceOf = (slug: string | null, tokenId: string | null): number | null => {
    if (!slug) return null;
    const m = mktBySlug.get(slug);
    if (!m || !tokenId) return null;
    const idx = m.clobTokenIds.indexOf(String(tokenId));
    if (idx < 0 || !(idx in m.outcomePrices)) return null;
    return m.outcomePrices[idx];
  };

  let copied = 0;
  const copiedSlugs = new Set<string>(); // dedup: max 1 copy per market
  for (const ot of unscored) {
    const walletGlobalScore = ot.wallet?.globalScore ?? 50;

    const side = ot.side ?? "BUY";
    const perf = copyPerf.get(`${ot.walletAddress}|${side}`);
    const totalPnl = walletTotalPnl.get(ot.walletAddress) ?? 0;
    const openCount = walletOpenCount.get(ot.walletAddress) ?? 0;

    // Copy-performance filter (pure, testable): catastrophic-loss stop, diversification
    // cap, and per-(wallet, side) performance. See walletCopySkipReason in scoring.ts.
    const skipReason = walletCopySkipReason(
      { side, count: perf?.count ?? 0, avgPnl: perf?.avgPnl ?? 0, winRate: perf?.winRate ?? 0, totalPnl, openCount },
      rules,
    );
    if (skipReason) {
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id,
          walletAddress: ot.walletAddress,
          marketId: ot.marketId,
          decision: "skip",
          copyScore: 0,
          reasonsJson: JSON.stringify([skipReason]),
          walletQualityScore: walletGlobalScore,
        },
      });
      continue;
    }
    // Live price of the wallet's outcome token + movement since the wallet's entry.
    const m = ot.slug ? mktBySlug.get(ot.slug) : undefined;
    const currentPrice = priceOf(ot.slug, ot.tokenId) ?? ot.detectedPrice ?? 0.5;
    const detectedPrice = ot.detectedPrice ?? currentPrice;
    const priceMovementSinceEntry = currentPrice - detectedPrice; // +ve = already moved in our favor => late
    const daysToResolution = m?.endDate
      ? (new Date(m.endDate).getTime() - Date.now()) / 86_400_000
      : daysToResolutionFromSlug(ot.slug);
    const volume = m?.volume ?? 0;

    // The market-variable "equation" (scoreTradeByMarket) is the PRIMARY selector and
    // is wallet-independent. Wallet identity is NOT a gate — only our adaptive
    // (wallet, side) copy track record (copyPerf) affects sizing below.
    const input: TradeInput = {
      walletGlobalScore,
      priceMovementSinceEntry,
      spread: ot.marketSpread ?? m?.spread ?? 0.03,
      liquidity: ot.marketLiquidity ?? m?.liquidity ?? 10_000,
      volume,
      timeToResolution: daysToResolution,
      currentPrice,
      side: ot.side ?? "BUY",
      category: ot.marketCategory ?? categoryFromSlug(ot.slug) ?? undefined,
    };
    const result = scoreTrade(input, rules);
    const dj = await prisma.decisionJournal.create({
      data: {
        observedTradeId: ot.id,
        walletAddress: ot.walletAddress,
        marketId: ot.marketId,
        decision: result.decision,
        copyScore: result.score,
        reasonsJson: JSON.stringify(result.reasons),
        walletQualityScore: walletGlobalScore,
      },
    });
    if (result.decision === "paper_copy") {
      // Dedup: max 1 copy per market slug (prevents correlated double-bets on same game)
      if (ot.slug && copiedSlugs.has(ot.slug)) {
        await prisma.decisionJournal.update({
          where: { id: dj.id },
          data: { decision: "skip", copyScore: 0, reasonsJson: JSON.stringify(["already copied this market (dedup)"]) },
        });
        continue;
      }

      // Fetch executable CLOB entry (real ask + fees), not Gamma midpoint
      let executableEntry = currentPrice;
      let clobMeta: { bestAsk?: number; allInPrice?: number; fee?: number; spread?: number } = {};
      if (ot.tokenId) {
        try {
          const quote = await getExecutableBuyQuote(ot.tokenId, 15); // $15 budget sample
          if (quote) {
            executableEntry = quote.allInPrice;
            clobMeta = { bestAsk: quote.bestAsk, allInPrice: quote.allInPrice, fee: quote.fee, spread: quote.spread ?? undefined };
          }
        } catch { /* fall back to midpoint */ }
      }

      // Conviction-scaled sizing: proven (wallet, side) winners (positive avg copy
      // PnL over enough samples) get a larger paper size (up to $20); unproven stay $5.
      let confidence = result.score / 100;
      if (perf && perf.count >= rules.minWalletCopyCount && perf.avgPnl > 0) {
        confidence = Math.min(1, 0.6 + perf.avgPnl * 3);
      }
      // Paper entry = executable all-in price (ask + fees), not Gamma midpoint.
      const pt = createPaperTrade(
        { walletAddress: ot.walletAddress, marketId: ot.marketId, outcome: ot.outcome ?? "YES", side: ot.side ?? "BUY", entryPrice: executableEntry },
        confidence,
      );
      await prisma.paperTrade.create({
        data: {
          decisionJournalId: dj.id,
          walletAddress: pt.walletAddress,
          marketId: pt.marketId,
          slug: ot.slug ?? null,
          tokenId: ot.tokenId ?? null,
          outcome: pt.outcome,
          side: pt.side,
          entryPrice: pt.entryPrice,
          currentPrice: pt.currentPrice,
          simulatedPositionSize: pt.simulatedPositionSize,
          unrealizedPnl: pt.unrealizedPnl,
          realizedPnl: pt.realizedPnl,
          status: pt.status,
          openedAt: new Date(pt.openedAt),
        },
      });
      if (ot.slug) copiedSlugs.add(ot.slug);
      copied++;
      console.log(`  COPY: ${ot.slug?.slice(0, 35)} @ ${executableEntry.toFixed(4)} (ask=${clobMeta.bestAsk?.toFixed(3) ?? "?"} fee=${clobMeta.fee?.toFixed(4) ?? "?"})`);
    }
  }
  console.log(`scoreTrades done: ${unscored.length} scored, ${copied} paper_copy`);
}

if (require.main === module) runScoreTrades().catch(console.error);
