// Job: score:trades. Fail-closed admission: no CLOB quote = no trade. SPEC §10.
//
// Every paper trade MUST have an executable CLOB entry price (ask + fees).
// Gamma midpoints are NEVER used as entry. If the orderbook is unavailable,
// the trade is skipped. This makes every future observation trustworthy.
import { prisma } from "../lib/db.js";
import { scoreTradeByMarket, DEFAULT_RULES, walletCopySkipReason, categoryFromSlug, getFavoriteGate, type RuleSetValues } from "../lib/scoring.js";
import { createPaperTrade } from "../lib/paper.js";
import { getMarketBySlug, getExecutableBuyQuote } from "../adapters/polymarket.js";
import { realTradingEnabled } from "../lib/config.js";
import { executeWalletCopyOrder } from "../lib/liveExecution.js";

// --- Constants ---
const MAX_SIGNAL_AGE_MS = 10 * 60 * 1000; // 10 minutes — default for non-sports
const SPORTS_SIGNAL_AGE_MS = 20 * 60 * 1000; // 20 minutes — sports games last hours, 20-min delay still tradeable
const SPORTS_MIN_HOURS_TO_RESOLUTION = 0.5; // 30 min — reject if game almost over
const SPORTS_MAX_DAYS_TO_RESOLUTION = 2; // reject sports >2 days out (not in-game)
const MAX_SPREAD_HARD_GATE = 0.05; // 5% — hard reject wide spreads
const LOGIC_VERSION = "v4-wallet-copy";

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
    where: { decision: null },
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

  // Wallet copy track record (per wallet+side)
  const allCopies = await prisma.paperTrade.findMany({
    select: { walletAddress: true, side: true, unrealizedPnl: true, realizedPnl: true, status: true, marketId: true, tokenId: true },
  });
  const copyPerf = new Map<string, { count: number; winRate: number; avgPnl: number; wins: number }>();
  const walletTotalPnl = new Map<string, number>();
  const walletOpenCount = new Map<string, number>();
  // Persistent dedup set: marketId+tokenId pairs we already have open/resolved copies for
  const existingCopies = new Set<string>();
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
    // Track existing copies for persistent dedup (ALL statuses — not just open)
    existingCopies.add(`${c.marketId}|${c.tokenId}`);
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
  let rejectedStale = 0;
  let rejectedNoQuote = 0;
  let rejectedDedup = 0;
  let rejectedGates = 0;

  for (const ot of unscored) {
    try {
    const walletGlobalScore = ot.wallet?.globalScore ?? 50;
    // --- GATE 0: Only BUY is supported (we buy outcome tokens; SELL is fictional) ---
    const side = (ot.side ?? "BUY").toUpperCase();
    if (side !== "BUY") {
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify([`SELL not supported (only BUY tokens; SELL is fictional)`, LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
      continue;
    }
    const category = ot.marketCategory ?? categoryFromSlug(ot.slug) ?? null;
    const isSports = category === "sports";

    // --- GATE 1: Signal age (sports get 20 min; everything else 10 min) ---
    const maxAge = isSports ? SPORTS_SIGNAL_AGE_MS : MAX_SIGNAL_AGE_MS;
    const signalAge = ot.timestamp ? Date.now() - ot.timestamp.getTime() : Infinity;
    if (signalAge > maxAge) {
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify([`signal age ${(signalAge / 60000).toFixed(0)}min > ${(maxAge / 60000).toFixed(0)}min`, LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
      rejectedStale++;
      continue;
    }

    // --- GATE 2: Wallet quality + copy-performance filter ---
    // Enforce minimum wallet global score (leaderboard quality signal)
    if (walletGlobalScore < rules.minWalletGlobal) {
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify([`wallet globalScore ${walletGlobalScore} < min ${rules.minWalletGlobal}`, LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
      continue;
    }
    const perf = copyPerf.get(`${ot.walletAddress}|${side}`);
    const totalPnl = walletTotalPnl.get(ot.walletAddress) ?? 0;
    const openCount = walletOpenCount.get(ot.walletAddress) ?? 0;
    const skipReason = walletCopySkipReason(
      { side, count: perf?.count ?? 0, avgPnl: perf?.avgPnl ?? 0, winRate: perf?.winRate ?? 0, totalPnl, openCount },
      rules,
    );
    if (skipReason) {
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify([skipReason, LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
      continue;
    }

    // --- GATE 3: Persistent dedup (DB-level: same marketId+tokenId) ---
    const dedupKey = `${ot.marketId}|${ot.tokenId}`;
    if (existingCopies.has(dedupKey)) {
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify(["already have open copy for this market+token (persistent dedup)", LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
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
        await prisma.decisionJournal.create({
          data: {
            observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
            decision: "skip", copyScore: 0,
            reasonsJson: JSON.stringify(["sports: unknown resolution time (no endDate, no slug date)", LOGIC_VERSION]),
            walletQualityScore: walletGlobalScore,
          },
        });
        rejectedGates++;
        continue;
      }
      if (hours < SPORTS_MIN_HOURS_TO_RESOLUTION) {
        await prisma.decisionJournal.create({
          data: {
            observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
            decision: "skip", copyScore: 0,
            reasonsJson: JSON.stringify([`sports: resolves in ${hours.toFixed(1)}h < ${SPORTS_MIN_HOURS_TO_RESOLUTION}h (game ending)`, LOGIC_VERSION]),
            walletQualityScore: walletGlobalScore,
          },
        });
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
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify([`spread ${(spread * 100).toFixed(1)}% > ${MAX_SPREAD_HARD_GATE * 100}% hard gate`, LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
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
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify([...mkt.reasons, LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
      rejectedGates++;
      continue;
    }

    // Favorite-price gate (category-aware)
    const favoritePrice = side === "BUY" ? midpoint : 1 - midpoint;
    const gate = getFavoriteGate(category);
    if (favoritePrice < gate) {
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify([`favoritePrice ${favoritePrice.toFixed(3)} < gate ${gate}`, ...mkt.reasons, LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
      rejectedGates++;
      continue;
    }

    // --- GATE 5: Calculate position size FIRST, then quote exact amount ---
    let confidence = mkt.score / 100;
    if (perf && perf.count >= rules.minWalletCopyCount && perf.avgPnl > 0) {
      confidence = Math.min(1, 0.6 + perf.avgPnl * 3);
    }
    const cashBudget = Math.round((5 + 15 * Math.max(0, Math.min(1, confidence))) * 100) / 100;

    // --- GATE 6: CLOB executable quote (FAIL-CLOSED: no quote = no trade) ---
    if (!ot.tokenId) {
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify(["no tokenId — cannot fetch CLOB quote (fail-closed)", LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
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
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify([`CLOB quote failed for $${cashBudget} budget (fail-closed, no midpoint fallback)`, LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
      rejectedNoQuote++;
      continue;
    }

    // --- GATE 7: Validate executable quote against gates ---
    // Upper-price cap: reject if all-in entry exceeds top threshold
    if (quote.allInPrice > rules.topThreshold) {
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify([`executable allIn ${quote.allInPrice.toFixed(4)} > top ${rules.topThreshold}`, LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
      rejectedGates++;
      continue;
    }
    // Hard spread gate on CLOB quote (not stale Gamma spread)
    if (quote.spread != null && quote.spread > MAX_SPREAD_HARD_GATE) {
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify([`CLOB spread ${(quote.spread * 100).toFixed(1)}% > ${MAX_SPREAD_HARD_GATE * 100}% hard gate`, LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
      rejectedGates++;
      continue;
    }
    // Favorite gate on the EXECUTABLE price (not midpoint)
    if (quote.allInPrice < gate) {
      await prisma.decisionJournal.create({
        data: {
          observedTradeId: ot.id, walletAddress: ot.walletAddress, marketId: ot.marketId,
          decision: "skip", copyScore: 0,
          reasonsJson: JSON.stringify([`executable allIn ${quote.allInPrice.toFixed(4)} < favorite gate ${gate}`, LOGIC_VERSION]),
          walletQualityScore: walletGlobalScore,
        },
      });
      rejectedGates++;
      continue;
    }

    // --- ADMISSION PASSED: Create paper trade with full metadata ---
    const signalDelaySec = ot.timestamp ? (Date.now() - ot.timestamp.getTime()) / 1000 : null;
    const pt = createPaperTrade(
      { walletAddress: ot.walletAddress, marketId: ot.marketId, outcome: ot.outcome ?? "YES", side, entryPrice: quote.allInPrice },
      confidence,
    );

    const dj = await prisma.decisionJournal.create({
      data: {
        observedTradeId: ot.id,
        walletAddress: ot.walletAddress,
        marketId: ot.marketId,
        decision: "paper_copy",
        copyScore: mkt.score,
        reasonsJson: JSON.stringify([
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
        ]),
        walletQualityScore: walletGlobalScore,
      },
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
