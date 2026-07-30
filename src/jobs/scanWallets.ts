// Job: scan:wallets. Score wallets -> update WalletProfile.
// v2: expanded enrichment (top-200), tiered polling, fill aggregation into campaigns,
// probability-edge scoring (outcome - entryPrice), and Bayesian-lite category shrinkage.
import { prisma } from "../lib/db.js";
import { scoreWallet, DEFAULT_RULES, categoryFromSlug, type WalletInput } from "../lib/scoring.js";
import { getLeaderboard } from "../adapters/leaderboard.js";
import { getWalletTrades, type ObservedTradeRow } from "../adapters/trades.js";
import { getMarketBySlug } from "../adapters/polymarket.js";
import { isLive } from "../lib/config.js";

// --- Fill aggregation: merge split fills from same wallet+token within FILL_WINDOW ---
const FILL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

interface Campaign {
  tokenId: string;
  slug: string | null;
  side: string;
  firstTimestamp: number;   // unix seconds
  lastTimestamp: number;
  totalSize: number;
  weightedEntry: number;    // volume-weighted average entry price
  fills: number;
}

function aggregateCampaigns(trades: ObservedTradeRow[]): Campaign[] {
  // Group by tokenId, then merge fills within FILL_WINDOW_MS into one campaign
  const byToken = new Map<string, ObservedTradeRow[]>();
  for (const t of trades) {
    const key = t.tokenId;
    if (!byToken.has(key)) byToken.set(key, []);
    byToken.get(key)!.push(t);
  }
  const campaigns: Campaign[] = [];
  for (const [tokenId, fills] of byToken) {
    // Sort by time
    fills.sort((a, b) => a.timestamp - b.timestamp);
    let current: Campaign | null = null;
    for (const f of fills) {
      if (current && (f.timestamp - current.lastTimestamp) * 1000 <= FILL_WINDOW_MS) {
        // Merge into current campaign
        const totalCost = current.weightedEntry * current.totalSize + f.price * f.size;
        current.totalSize += f.size;
        current.weightedEntry = current.totalSize > 0 ? totalCost / current.totalSize : f.price;
        current.lastTimestamp = f.timestamp;
        current.fills++;
      } else {
        // Start new campaign
        if (current) campaigns.push(current);
        current = {
          tokenId,
          slug: f.slug ?? null,
          side: (f.side ?? "BUY").toUpperCase(),
          firstTimestamp: f.timestamp,
          lastTimestamp: f.timestamp,
          totalSize: f.size,
          weightedEntry: f.price,
          fills: 1,
        };
      }
    }
    if (current) campaigns.push(current);
  }
  return campaigns;
}

// --- Tiered polling: hot wallets refresh more often ---
const TIERS = {
  hot: { maxRank: 50, maxAgeMs: 15 * 60 * 1000 },   // 15 min
  warm: { maxRank: 200, maxAgeMs: 35 * 60 * 1000 },  // 35 min
  cold: { maxRank: 99999, maxAgeMs: 90 * 60 * 1000 }, // 90 min
};
const ENRICH_BATCH = 40; // wallets per slow-path pass

export async function runScanWallets(): Promise<void> {
  const profiles = await prisma.walletProfile.findMany({ orderBy: { sourceRank: { sort: "asc", nulls: "last" } } });
  if (!profiles.length) {
    console.log("scanWallets: no profiles found, skipping");
    return;
  }
  // Fetch live leaderboard rows for roi/volume data (MONTH horizon for durability)
  let lbMap = new Map<string, { totalPnl: number; volume: number; roi: number }>();
  if (isLive) {
    const lb = await getLeaderboard({ limit: 50, timePeriod: "MONTH", orderBy: "PNL" });
    for (const r of lb) lbMap.set(r.id, { totalPnl: r.totalPnl, volume: r.volume, roi: r.roi });
  }

  // Tiered enrichment selection: pick stale wallets by tier priority
  const nowMs = Date.now();
  const enrichIds = new Set<string>();
  for (const tier of [TIERS.hot, TIERS.warm, TIERS.cold]) {
    if (enrichIds.size >= ENRICH_BATCH) break;
    const candidates = profiles
      .filter((p) => p.sourceRank != null && p.sourceRank <= tier.maxRank)
      .filter((p) => !p.lastScannedAt || nowMs - p.lastScannedAt.getTime() > tier.maxAgeMs)
      .filter((p) => !enrichIds.has(p.id))
      .sort((a, b) => (a.lastScannedAt?.getTime() ?? 0) - (b.lastScannedAt?.getTime() ?? 0));
    for (const c of candidates) {
      if (enrichIds.size >= ENRICH_BATCH) break;
      enrichIds.add(c.id);
    }
  }

  // Shared market-metadata cache across all wallets in this pass
  const marketData = new Map<string, { liquidity: number; spread: number; category: string | null; endDate: string | null; outcomes: string[]; outcomePrices: number[]; clobTokenIds: string[] }>();

  for (const p of profiles) {
    try {
      const lb = lbMap.get(p.address);
      const shouldEnrich = isLive && enrichIds.has(p.id);

      let enriched: {
        tradeCount30d?: number;
        averageLiquidity?: number;
        averageSpread?: number;
        categoryStrengths?: Record<string, number>;
        resolvedTradeCount30d?: number;
        winRate30d?: number;
        averageEntryTiming?: number;
        tradePnls?: number[];
        returnVariance?: number;
      } = {};

      if (shouldEnrich) {
        const trades = await getWalletTrades(p.address, { limit: 40 });
        await new Promise((r) => setTimeout(r, 200)); // pace data-api calls
        const slugs = [...new Set(trades.map((t) => t.slug).filter(Boolean) as string[])];

        for (const slug of slugs) {
          if (!marketData.has(slug)) {
            const mkt = await getMarketBySlug(slug);
            if (mkt) marketData.set(slug, { liquidity: mkt.liquidity, spread: mkt.spread, category: mkt.category, endDate: mkt.endDate, outcomes: mkt.outcomes, outcomePrices: mkt.outcomePrices, clobTokenIds: mkt.clobTokenIds });
          }
          await new Promise((r) => setTimeout(r, 100));
        }

        // --- Campaign-based scoring (fill aggregation) ---
        const campaigns = aggregateCampaigns(trades);
        const now = Date.now();
        const histEdges: number[] = [];   // probability residuals for resolved
        const histPnls: number[] = [];
        const entryTimings: number[] = [];
        let wins = 0;
        let resolvedCount = 0;
        let liveWins = 0;
        let openCount = 0;
        const catEdges: Record<string, number[]> = {}; // category -> probability residuals

        for (const camp of campaigns) {
          const mkt = camp.slug ? marketData.get(camp.slug) : undefined;
          if (!mkt) continue;
          const idx = mkt.clobTokenIds.indexOf(String(camp.tokenId));
          if (idx < 0 || !(idx in mkt.outcomePrices)) continue;
          const cur = mkt.outcomePrices[idx];
          const entry = camp.weightedEntry;
          const side = camp.side;
          const end = mkt.endDate ? new Date(mkt.endDate).getTime() : NaN;
          const cat = categoryFromSlug(camp.slug) ?? mkt.category;

          if (isNaN(end) || end >= now) {
            // Open market: live directional signal
            openCount++;
            const favorable = side === "SELL" ? entry - cur : cur - entry;
            if (favorable > 0) liveWins++;
            continue;
          }

          // Resolved market: historical signal
          const won = side === "SELL" ? cur < 0.5 : cur >= 0.5;
          const outcome = won ? 1 : 0;
          // Probability edge: how much better was the wallet than the price paid?
          const probEdge = side === "SELL" ? (1 - outcome) - (1 - entry) : outcome - entry;
          histEdges.push(probEdge);
          histPnls.push((won ? 1 - entry : -entry) * camp.totalSize);
          if (won) wins++;
          resolvedCount++;
          if (cat) {
            if (!catEdges[cat]) catEdges[cat] = [];
            catEdges[cat].push(probEdge);
          }
          const entered = new Date(camp.firstTimestamp * 1000).getTime();
          entryTimings.push(Math.max(0, (end - entered) / 86_400_000));
        }

        const historicalWinRate = resolvedCount ? wins / resolvedCount : 0;
        const liveWinRate = openCount ? liveWins / openCount : 0;
        const winRate30d = resolvedCount >= 3 ? historicalWinRate : liveWinRate;
        const averageEntryTiming = entryTimings.length ? entryTimings.reduce((a, b) => a + b, 0) / entryTimings.length : 0;

        // Category strengths with shrinkage: shrunkEdge = n/(n+k) * observed + k/(n+k) * globalPrior
        // k=10 campaigns for category to reach half-weight. Prevents 2/2 = 100% inflation.
        const SHRINK_K = 10;
        const globalEdge = histEdges.length ? histEdges.reduce((a, b) => a + b, 0) / histEdges.length : 0;
        const categoryStrengths: Record<string, number> = {};
        for (const [cat, edges] of Object.entries(catEdges)) {
          if (edges.length < 2) continue; // need at least 2 campaigns
          const observed = edges.reduce((a, b) => a + b, 0) / edges.length;
          const weight = edges.length / (edges.length + SHRINK_K);
          // Shrunk edge: blend observed category edge with global wallet edge
          const shrunk = weight * observed + (1 - weight) * globalEdge;
          // Convert to a 0-1 "strength" for compatibility with existing scoring:
          // base win rate + edge bonus (edge is typically -0.3 to +0.3)
          const catWinRate = edges.filter((e) => e > 0).length / edges.length;
          categoryStrengths[cat] = Math.min(1, Math.max(0, catWinRate + shrunk * 0.5));
        }

        const pnlsForStats = resolvedCount >= 3 ? histPnls : [];
        const returnVariance = (() => {
          if (pnlsForStats.length < 2) return 0;
          const mean = pnlsForStats.reduce((a, b) => a + b, 0) / pnlsForStats.length;
          const variance = pnlsForStats.reduce((a, b) => a + (b - mean) ** 2, 0) / pnlsForStats.length;
          const std = Math.sqrt(variance);
          return Math.min(1, Math.max(0, std / (Math.abs(mean) + 1e-6)));
        })();

        const mkts = trades.map((t) => marketData.get(t.slug ?? "")).filter((m): m is NonNullable<typeof m> => !!m);
        const avgLiq = mkts.length ? mkts.reduce((s, m) => s + m.liquidity, 0) / mkts.length : 0;
        const avgSpr = mkts.length ? mkts.reduce((s, m) => s + m.spread, 0) / mkts.length : 0;

        enriched = {
          tradeCount30d: campaigns.length, // unique campaigns, not raw fills
          averageLiquidity: avgLiq,
          averageSpread: avgSpr,
          categoryStrengths,
          resolvedTradeCount30d: resolvedCount,
          winRate30d,
          averageEntryTiming,
          tradePnls: resolvedCount >= 3 ? histPnls : [],
          returnVariance,
        };
      }

      // Resolve categoryStrengths for WalletInput and DB write
      const cats: Record<string, number> = enriched.categoryStrengths
        ?? (p.categoryStrengthsJson ? JSON.parse(p.categoryStrengthsJson) : {});
      // Remove internal _scopes key if present (stored by scanLeaderboard)
      delete (cats as any)._scopes;

      const input: WalletInput = {
        roi30d: lb?.roi ?? p.roi30d ?? 0,
        winRate30d: enriched.winRate30d ?? p.winRate30d ?? 0,
        resolvedTradeCount30d: enriched.resolvedTradeCount30d ?? p.resolvedTradeCount30d ?? 0,
        tradeCount30d: enriched.tradeCount30d ?? p.tradeCount30d ?? 0,
        averageLiquidity: enriched.averageLiquidity ?? p.averageLiquidity ?? 0,
        averageSpread: enriched.averageSpread ?? p.averageSpread ?? 0,
        averageEntryTiming: enriched.averageEntryTiming ?? p.averageEntryTiming ?? 0,
        categoryStrengths: cats,
        tradePnls: enriched.tradePnls ?? [],
        returnVariance: enriched.returnVariance ?? 0,
      };

      const result = scoreWallet(input, DEFAULT_RULES);

      // globalScore reflects wallet quality only. We deliberately do NOT penalize for
      // open copies' unrealized dips: under hold-to-resolution that is noise, and realized
      // performance is already gated downstream (walletCopySkipReason: maxWalletLoss,
      // win-rate, avg-PnL). No gate in this system may act on unrealized PnL.
      const global = result.global;

      // Per-segment performance is handled downstream by walletCopySkipReason
      // (win-rate + avg-PnL per segment after minWalletCopyCount samples).
      // No global aggregate demotion: tennis losses must not suppress MLB-proven wallets.
      let status: "track" | "watch" | "ignore";
      status = global >= 20 ? "track"
        : global >= 10 ? "watch"
        : "ignore";

      const bestCategory = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      await prisma.walletProfile.update({
        where: { id: p.id },
        data: {
          globalScore: global,
          scoreComponentsJson: JSON.stringify(result.components),
          // Only stamp scan time when we actually enriched (fetched fresh trades).
          // Stamping every wallet broke tiered polling: staleness selection at line ~94
          // could never see a wallet as stale, so warm/cold tiers were starved.
          lastScannedAt: shouldEnrich ? new Date() : p.lastScannedAt,
          status,
          roi30d: lb?.roi ?? p.roi30d,
          tradeCount30d: input.tradeCount30d,
          resolvedTradeCount30d: input.resolvedTradeCount30d,
          winRate30d: input.winRate30d,
          averageLiquidity: input.averageLiquidity,
          averageSpread: input.averageSpread,
          averageEntryTiming: input.averageEntryTiming,
          categoryStrengthsJson: JSON.stringify(cats),
          bestCategory,
          averageTradeSize: p.averageTradeSize ?? (lb?.volume != null && p.tradeCount30d ? lb.volume / p.tradeCount30d : null),
        },
      });
    } catch (err) {
      console.error(`scanWallets: error processing wallet ${p.address}:`, err);
    }
  }
  console.log(`scanWallets done: ${profiles.length} wallets scored, ${enrichIds.size} enriched`);
}

if (require.main === module) runScanWallets().catch(console.error);
