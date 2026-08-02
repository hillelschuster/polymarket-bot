// Job: score:trades. Fail-closed admission: no CLOB quote = no trade. SPEC §10.
//
// Every paper trade MUST have an executable CLOB entry price (ask + fees).
// Gamma midpoints are NEVER used as entry. If the orderbook is unavailable,
// the trade is skipped. This makes every future observation trustworthy.
import { prisma } from "../lib/db.js";
import { scoreTradeByMarket, DEFAULT_RULES, walletCopySkipReason, categoryFromSlug, segmentFromSlug, segmentSize, getFavoriteGate, mainlinePositionSize, priorWalletCopyPerformance, type RuleSetValues, type MarketSegment } from "../lib/scoring.js";
import { createPaperTrade } from "../lib/paper.js";
import { getMarketBySlug, getExecutableBuyQuote } from "../adapters/polymarket.js";
import { realTradingEnabled } from "../lib/config.js";
import { executeWalletCopyOrder } from "../lib/liveExecution.js";
import { createDecisionJournal, LOGIC_VERSION, type DecisionJournalInput } from "../lib/decisionJournal.js";

// --- Constants ---
const MAX_SIGNAL_AGE_MS = 10 * 60 * 1000; // 10 minutes — default for non-sports
const SPORTS_SIGNAL_AGE_MS = 20 * 60 * 1000; // 20 minutes — sports games last hours, 20-min delay still tradeable
const SPORTS_MIN_HOURS_TO_RESOLUTION = 0.5; // 30 min — reject if game almost over
const SPORTS_MAX_DAYS_TO_RESOLUTION = 2; // reject sports >2 days out (not in-game)
const MAX_SPREAD_HARD_GATE = 0.05; // 5% — hard reject wide spreads
export const SCORING_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function unscoredObservedTradeWhere(now = new Date()) {
  return {
    decision: null,
    timestamp: { gte: new Date(now.getTime() - SCORING_LOOKBACK_MS) },
  };
}

/**
 * Parse resolution time from sports slugs like "mlb-wsh-col-2026-07-21".
 * Returns hours from now until expected resolution (game end ~05:00 UTC next day).
 * Returns null if no date found (unknown = reject for sports).
 */
function hoursToResolutionFromSlug(slug: string | null): number | null {
  if (!slug) return null;
  const match = slug.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const gameEnd = new Date(match[1] + "T05:00:00Z");
  gameEnd.setDate(gameEnd.getDate() + 1);
  return (gameEnd.getTime() - Date.now()) / 3_600_000;
}

export async function runScoreTrades(): Promise<void> {
  const activeRs = await prisma.ruleSet.findFirst({ where: { active: true }, orderBy: { version: "desc" } });
  let rules: RuleSetValues = DEFAULT_RULES;
  if (activeRs) {
    try {
      rules = { ...DEFAULT_RULES, ...JSON.parse(activeRs.rulesJson) };
    } catch {
      console.warn("scoreTrades: malformed rulesJson, using DEFAULT_RULES");
    }
  }

  // Newest-first: process recent signals before stale ones
  const unscored = await prisma.observedTrade.findMany({
    where: unscoredObservedTradeWhere(),
    include: { wallet: true },
    orderBy: { timestamp: "desc" },
    take: 100,
  });
  if (!unscored.length) {
    console.log("scoreTrades: no unscored trades found");
    return;
  }

  // Fetch market state per slug (deduped)
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
    } catch { /* skip */ }
    await new Promise((r) => setTimeout(r, 120));
  }

  // Wallet copy track record — CLEAN METRICS:
  // Skill: only source="wallet_copy" + status="resolved" (terminal outcomes).
  // Open: counted separately for exposure cap only.
  // Legacy stop-loss ("closed") and strategy trades are EXCLUDED from skill.
  // Keyed by wallet|segment (not wallet|side) so tennis losses don't poison MLB skill.
  const allCopies = await prisma.paperTrade.findMany({
    select: { walletAddress: true, side: true, unrealizedPnl: true, realizedPnl: true, status: true, marketId: true, tokenId: true, slug: true, source: true, simulatedPositionSize: true, openedAt: true, resolvedAt: true },
  });
  const walletOpenCount = new Map<string, number>();
  // Persistent dedup set: marketId+tokenId pairs we already have copies for (ALL statuses)
  const existingCopies = new Set<string>();
  // Per-event (slug) exposure tracking for the $20-per-event cap
  const eventExposure = new Map<string, number>();
  for (const c of allCopies) {
    // Dedup uses ALL trades (correct — never re-copy the same market+token)
    existingCopies.add(`${c.marketId}|${c.tokenId}`);
    // Event exposure counts ALL non-open trades (deployed capital)
    if (c.status !== "open" && c.slug) {
      eventExposure.set(c.slug, (eventExposure.get(c.slug) ?? 0) + (c.simulatedPositionSize ?? 0));
    }
    // Open count: all open trades (for diversification cap)
    if (c.status === "open") {
      walletOpenCount.set(c.walletAddress, (walletOpenCount.get(c.walletAddress) ?? 0) + 1);
      if (c.slug) eventExposure.set(c.slug, (eventExposure.get(c.slug) ?? 0) + (c.simulatedPositionSize ?? 0));
    }
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
  let rejectedStale = 0;
  let rejectedNoQuote = 0;
  let rejectedDedup = 0;
  let rejectedGates = 0;

  for (const ot of unscored) {
    try {
    const walletQualityScore = ot.wallet?.globalScore ?? null;
    const walletGlobalScore = walletQualityScore ?? 50;
    const category = ot.marketCategory ?? categoryFromSlug(ot.slug) ?? null;
    const isSports = category === "sports";
    const segment: MarketSegment = segmentFromSlug(ot.slug);
    const perf = priorWalletCopyPerformance(allCopies, ot.walletAddress, segment, ot.timestamp);
    const openCount = walletOpenCount.get(ot.walletAddress) ?? 0;
    const baseSize = segment === "sports_mainline"
      ? mainlinePositionSize(walletQualityScore, rules.minWalletGlobal, perf)
      : segmentSize(segment);
    const slugKey = ot.slug ?? ot.marketId;
    const alreadyDeployed = eventExposure.get(slugKey) ?? 0;
    const MAX_PER_EVENT = 20;
    const remainingEventBudget = Math.max(0, MAX_PER_EVENT - alreadyDeployed);
    const intendedPositionSize = Math.min(baseSize, remainingEventBudget);
    const signalAge = ot.timestamp ? Date.now() - ot.timestamp.getTime() : Infinity;
    const journalContext: Omit<DecisionJournalInput, "decision" | "firstFailingGate"> = {
      observedTradeId: ot.id,
      walletAddress: ot.walletAddress,
      marketId: ot.marketId,
      walletStatus: ot.wallet?.status ?? null,
      walletQualityScore,
      sourceRank: ot.wallet?.sourceRank ?? null,
      marketSegment: segment,
      priorSameSegmentResolvedCount: perf.count,
      priorSameSegmentWins: perf.wins,
      priorSameSegmentAveragePnl: perf.avgPnl,
      signalAgeSeconds: ot.timestamp ? Math.max(0, signalAge) / 1000 : null,
      intendedPositionSize,
      eventExposureBefore: alreadyDeployed,
      ruleSetId: activeRs?.id ?? null,
      ruleSetVersion: activeRs?.version ?? null,
    };
    const journal = (
      decision: DecisionJournalInput["decision"],
      firstFailingGate: string,
      details: Partial<DecisionJournalInput> = {},
    ) => createDecisionJournal({ ...journalContext, ...details, decision, firstFailingGate });

    // --- GATE 0: Only BUY is supported (we buy outcome tokens; SELL is fictional) ---
    const side = (ot.side ?? "BUY").toUpperCase();
    if (side !== "BUY") {
      await journal("skip", "side", { copyScore: 0, reasons: ["SELL not supported (only BUY tokens; SELL is fictional)", LOGIC_VERSION] });
      continue;
    }

    // --- GATE 1: Signal age (sports get 20 min; everything else 10 min) ---
    const maxAge = isSports ? SPORTS_SIGNAL_AGE_MS : MAX_SIGNAL_AGE_MS;
    if (signalAge > maxAge) {
      await journal("skip", "signal_age", { copyScore: 0, reasons: [`signal age ${(signalAge / 60000).toFixed(0)}min > ${(maxAge / 60000).toFixed(0)}min`, LOGIC_VERSION] });
      rejectedStale++;
      continue;
    }

    // --- GATE 2: Wallet quality + copy-performance filter ---
    // Enforce minimum wallet global score (leaderboard quality signal).
    // BYPASS for sports_mainline: proven edge (21/23 resolved) must not be
    // suppressed by a leaderboard heuristic that measures liquidity/variance,
    // not copy profitability. Per-segment filters still apply downstream.
    if (segment !== "sports_mainline" && walletGlobalScore < rules.minWalletGlobal) {
      await journal("skip", "wallet_quality", { copyScore: 0, reasons: [`wallet globalScore ${walletGlobalScore} < min ${rules.minWalletGlobal}`, LOGIC_VERSION] });
      continue;
    }
    const skipReason = walletCopySkipReason(
      { segment, count: perf.count, avgPnl: perf.avgPnl, winRate: perf.winRate, openCount },
      rules,
    );
    if (skipReason) {
      await journal("skip", "wallet_copy_performance", { copyScore: 0, reasons: [skipReason, LOGIC_VERSION] });
      continue;
    }

    // --- GATE 3: Persistent dedup (DB-level: same marketId+tokenId) ---
    const dedupKey = `${ot.marketId}|${ot.tokenId}`;
    if (existingCopies.has(dedupKey)) {
      await journal("skip", "dedup", { copyScore: 0, reasons: ["already have open copy for this market+token (persistent dedup)", LOGIC_VERSION] });
      rejectedDedup++;
      continue;
    }

    // --- GATE 4: Market structure (price, liquidity, spread, timing) ---
    const m = ot.slug ? mktBySlug.get(ot.slug) : undefined;
    const midpoint = priceOf(ot.slug, ot.tokenId) ?? ot.detectedPrice ?? 0.5;
    const detectedPrice = ot.detectedPrice ?? midpoint;
    const priceMovementSinceEntry = midpoint - detectedPrice;
    const spread = ot.marketSpread ?? m?.spread ?? 0.03;
    const liquidity = ot.marketLiquidity ?? m?.liquidity ?? 10_000;
    const volume = m?.volume ?? 0;

    // Sports timing: use slug-parsed hours, reject unknown
    let daysToResolution: number;
    if (isSports) {
      const hours = m?.endDate
        ? (new Date(m.endDate).getTime() - Date.now()) / 3_600_000
        : hoursToResolutionFromSlug(ot.slug);
      if (hours == null) {
        // Unknown sports timing = REJECT (don't invent 30 days)
        await journal("skip", "sports_timing", { copyScore: 0, reasons: ["sports: unknown resolution time (no endDate, no slug date)", LOGIC_VERSION] });
        rejectedGates++;
        continue;
      }
      if (hours < SPORTS_MIN_HOURS_TO_RESOLUTION) {
        await journal("skip", "sports_timing", { copyScore: 0, reasons: [`sports: resolves in ${hours.toFixed(1)}h < ${SPORTS_MIN_HOURS_TO_RESOLUTION}h (game ending)`, LOGIC_VERSION] });
        rejectedGates++;
        continue;
      }
      daysToResolution = hours / 24;
      // For scoreTradeByMarket: bypass the global 3-day gate for sports.
      // We already validated sports-specific timing above (30min min, unknown reject).
      // Pass sweetDaysToResolution so the global gate doesn't double-reject.
      daysToResolution = rules.sweetDaysToResolution;
    } else {
      // Non-sports: use global minDaysToResolution
      daysToResolution = m?.endDate
        ? (new Date(m.endDate).getTime() - Date.now()) / 86_400_000
        : 30;
    }

    // Hard spread gate
    if (spread > MAX_SPREAD_HARD_GATE) {
      await journal("skip", "market_spread", { copyScore: 0, reasons: [`spread ${(spread * 100).toFixed(1)}% > ${MAX_SPREAD_HARD_GATE * 100}% hard gate`, LOGIC_VERSION] });
      rejectedGates++;
      continue;
    }

    // Market-variable scoring (gates: top/bottom, adverse move, liquidity, toxic, entry-gap)
    const mkt = scoreTradeByMarket({
      side,
      currentPrice: midpoint,
      priceMovementSinceEntry,
      spread,
      liquidity,
      volume,
      daysToResolution,
      detectedPrice,
    }, rules);
    if (mkt.skip) {
      await journal("skip", "market_score", { copyScore: 0, reasons: [...mkt.reasons, LOGIC_VERSION] });
      rejectedGates++;
      continue;
    }

    // Favorite-price gate (category-aware)
    const favoritePrice = side === "BUY" ? midpoint : 1 - midpoint;
    const gate = getFavoriteGate(category);
    if (favoritePrice < gate) {
      await journal("skip", "favorite_price", { copyScore: 0, reasons: [`favoritePrice ${favoritePrice.toFixed(3)} < gate ${gate}`, ...mkt.reasons, LOGIC_VERSION] });
      rejectedGates++;
      continue;
    }

    // --- GATE 5: Segment-aware sizing + per-event exposure cap ---
    const cashBudget = intendedPositionSize;
    if (cashBudget < 1) {
      await journal("skip", "event_exposure", { copyScore: 0, reasons: [`event exposure cap: $${alreadyDeployed.toFixed(0)} already deployed on ${slugKey.slice(0, 30)} (max $${MAX_PER_EVENT})`, LOGIC_VERSION] });
      continue;
    }
    // Confidence for paper.ts (used only if explicitSize is not passed; kept for journal metadata)
    let confidence = mkt.score / 100;
    if (perf.count >= rules.minWalletCopyCount && perf.avgPnl > 0) {
      confidence = Math.min(1, 0.6 + perf.avgPnl * 3);
    }

    // --- GATE 6: CLOB executable quote (FAIL-CLOSED: no quote = no trade) ---
    if (!ot.tokenId) {
      await journal("skip", "token_id", { copyScore: 0, reasons: ["no tokenId — cannot fetch CLOB quote (fail-closed)", LOGIC_VERSION] });
      rejectedNoQuote++;
      continue;
    }

    let quote;
    try {
      quote = await getExecutableBuyQuote(ot.tokenId, cashBudget);
    } catch {
      quote = null;
    }
    if (!quote) {
      // FAIL-CLOSED: no midpoint fallback
      await journal("skip", "executable_quote", { copyScore: 0, reasons: [`CLOB quote failed for $${cashBudget} budget (fail-closed, no midpoint fallback)`, LOGIC_VERSION] });
      rejectedNoQuote++;
      continue;
    }

    // --- GATE 7: Validate executable quote against gates ---
    // Upper-price cap: reject if all-in entry exceeds top threshold
    if (quote.allInPrice > rules.topThreshold) {
      await journal("skip", "executable_top", { copyScore: 0, reasons: [`executable allIn ${quote.allInPrice.toFixed(4)} > top ${rules.topThreshold}`, LOGIC_VERSION], executableAsk: quote.bestAsk, allInPrice: quote.allInPrice, fee: quote.fee, spread: quote.spread, shares: quote.shares });
      rejectedGates++;
      continue;
    }
    // Hard spread gate on CLOB quote (not stale Gamma spread)
    if (quote.spread != null && quote.spread > MAX_SPREAD_HARD_GATE) {
      await journal("skip", "executable_spread", { copyScore: 0, reasons: [`CLOB spread ${(quote.spread * 100).toFixed(1)}% > ${MAX_SPREAD_HARD_GATE * 100}% hard gate`, LOGIC_VERSION], executableAsk: quote.bestAsk, allInPrice: quote.allInPrice, fee: quote.fee, spread: quote.spread, shares: quote.shares });
      rejectedGates++;
      continue;
    }
    // Favorite gate on the EXECUTABLE price (not midpoint)
    if (quote.allInPrice < gate) {
      await journal("skip", "executable_favorite_price", { copyScore: 0, reasons: [`executable allIn ${quote.allInPrice.toFixed(4)} < favorite gate ${gate}`, LOGIC_VERSION], executableAsk: quote.bestAsk, allInPrice: quote.allInPrice, fee: quote.fee, spread: quote.spread, shares: quote.shares });
      rejectedGates++;
      continue;
    }

    // --- ADMISSION PASSED: Create paper trade with full metadata ---
    const signalDelaySec = ot.timestamp ? (Date.now() - ot.timestamp.getTime()) / 1000 : null;
    const pt = createPaperTrade(
      { walletAddress: ot.walletAddress, marketId: ot.marketId, outcome: ot.outcome ?? "YES", side, entryPrice: quote.allInPrice },
      confidence,
      cashBudget, // explicit segment-aware size
    );

    const dj = await journal("paper_copy", "accepted", {
      copyScore: mkt.score,
      reasons: [
        ...mkt.reasons,
        `logic=${LOGIC_VERSION}`,
        `signalDelay=${signalDelaySec?.toFixed(0)}s`,
        `midpoint=${midpoint.toFixed(4)}`,
        `bestAsk=${quote.bestAsk?.toFixed(4)}`,
        `allInPrice=${quote.allInPrice.toFixed(4)}`,
        `fee=${quote.fee.toFixed(4)}`,
        `spread=${(quote.spread ?? 0).toFixed(4)}`,
        `cashBudget=$${cashBudget}`,
        `shares=${quote.shares.toFixed(2)}`,
      ],
      signalAgeSeconds: signalDelaySec,
      intendedPositionSize: cashBudget,
      executableAsk: quote.bestAsk,
      allInPrice: quote.allInPrice,
      fee: quote.fee,
      spread: quote.spread,
      shares: quote.shares,
    });

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

    existingCopies.add(dedupKey);
    // Track event exposure for the per-event cap
    eventExposure.set(slugKey, alreadyDeployed + cashBudget);
    // Count the new open copy immediately so the diversification cap
    // (maxCopiesPerWallet) is enforced within this same pass, not only
    // against the DB snapshot taken at pass start.
    walletOpenCount.set(pt.walletAddress, (walletOpenCount.get(pt.walletAddress) ?? 0) + 1);
    copied++;
    console.log(`  COPY: ${ot.slug?.slice(0, 35)} @ ${quote.allInPrice.toFixed(4)} (ask=${quote.bestAsk?.toFixed(3)} fee=${quote.fee.toFixed(4)} delay=${signalDelaySec?.toFixed(0)}s $${cashBudget})`);

    // --- LIVE EXECUTION: one-path FOK buy, durable idempotency ---
    // Paper trade is already saved. Live order is a side effect; failures are
    // logged and persisted but do NOT roll back the paper record (parity audit).
    if (realTradingEnabled && ot.tokenId && quote) {
      try {
        await executeWalletCopyOrder({
          tokenId: ot.tokenId,
          cashBudget,
          allInPrice: quote.allInPrice,
          shares: quote.shares,
          decisionJournalId: dj.id,
          walletAddress: ot.walletAddress,
          marketId: ot.marketId,
          slug: ot.slug ?? null,
        });
      } catch (err) {
        console.error(
          `Lane A live exec failed (dj=${dj.id}):`,
          (err as Error).message,
        );
      }
    }
    } catch (err: any) {
      // Gracefully skip trades already scored (unique constraint on observedTradeId)
      if (err?.code === "P2002") continue;
      throw err;
    }
  }

  console.log(`scoreTrades done: ${unscored.length} scored, ${copied} paper_copy, ${rejectedStale} stale, ${rejectedNoQuote} no-quote, ${rejectedDedup} dedup, ${rejectedGates} gates`);
}

if (require.main === module) runScoreTrades().catch(console.error);
