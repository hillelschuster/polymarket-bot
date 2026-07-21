// Job: scan:wallets. Score top wallets -> update WalletProfile. SPEC §10.
import { prisma } from "../lib/db.js";
import { scoreWallet, DEFAULT_RULES, categoryFromSlug, type WalletInput } from "../lib/scoring.js";
import { getLeaderboard } from "../adapters/leaderboard.js";
import { getWalletTrades } from "../adapters/trades.js";
import { getMarketBySlug } from "../adapters/polymarket.js";
import { isLive } from "../lib/config.js";

export async function runScanWallets(): Promise<void> {
  const profiles = await prisma.walletProfile.findMany({ orderBy: { sourceRank: { sort: "asc", nulls: "last" } } });
  if (!profiles.length) {
    console.log("scanWallets: no profiles found, skipping");
    return;
  }
  // Fetch live leaderboard rows for roi/volume data if live
  let lbMap = new Map<string, { totalPnl: number; volume: number; roi: number }>();
  if (isLive) {
    const lb = await getLeaderboard({ limit: 50 });
    for (const r of lb) lbMap.set(r.id, { totalPnl: r.totalPnl, volume: r.volume, roi: r.roi });
  }

  // Bounded, resumable enrichment: only refresh a small batch of top wallets per pass
  // (oldest first) so scan:wallets always finishes inside the process-time budget and
  // the loop never gets SIGKILLed mid-enrichment. Top-50 fully refresh every ~4 passes.
  const ENRICH_BATCH = 12;
  const ENRICH_MAX_AGE_MS = 30 * 60 * 1000;
  const nowMs = Date.now();
  const enrichIds = new Set(
    profiles
      .filter((p) => p.sourceRank != null && p.sourceRank <= 50)
      .sort((a, b) => (a.lastScannedAt?.getTime() ?? 0) - (b.lastScannedAt?.getTime() ?? 0))
      .filter((p) => !p.lastScannedAt || nowMs - p.lastScannedAt.getTime() > ENRICH_MAX_AGE_MS)
      .slice(0, ENRICH_BATCH)
      .map((p) => p.id),
  );

  // Shared market-metadata cache across all wallets in this pass (avoids re-fetching
  // hot markets 50× and the resulting 429 rate-limit storms that corrupted scores).
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
        const trades = await getWalletTrades(p.address, { limit: 20 });
        await new Promise((r) => setTimeout(r, 200)); // pace data-api calls (avoid 429)
        const slugs = [...new Set(trades.map((t) => t.slug).filter(Boolean) as string[])];

        // Fetch market metadata per slug (gamma's condition_id filter is broken; slug is reliable).
        // marketData is shared across wallets within this pass, so a hot market is fetched once.
        for (const slug of slugs) {
          if (!marketData.has(slug)) {
            const mkt = await getMarketBySlug(slug);
            if (mkt) marketData.set(slug, { liquidity: mkt.liquidity, spread: mkt.spread, category: mkt.category, endDate: mkt.endDate, outcomes: mkt.outcomes, outcomePrices: mkt.outcomePrices, clobTokenIds: mkt.clobTokenIds });
          }
          await new Promise((r) => setTimeout(r, 100));
        }

        const tradeCount = trades.length;
        const mkts = trades.map((t) => marketData.get(t.slug ?? "")).filter((m): m is NonNullable<typeof m> => !!m);
        const avgLiq = mkts.length ? mkts.reduce((s, m) => s + m.liquidity, 0) / mkts.length : 0;
        const avgSpr = mkts.length ? mkts.reduce((s, m) => s + m.spread, 0) / mkts.length : 0;

        // Real wallet-quality signals (v1). Two sources, combined:
        //  - RESOLVED trades → historical win rate, entry timing, realized PnL.
        //  - OPEN trades → live directional win rate (current price vs wallet's fill),
        //    used as a proxy for bet quality/consistency while markets are mostly unsettled.
        // ponytail: right now most top wallets trade markets resolving end-of-period, so
        // resolved history is sparse; the live directional signal is the actionable one.
        const now = Date.now();
        const histPnls: number[] = [];
        const entryTimings: number[] = [];
        let wins = 0;
        let resolvedCount = 0;
        let liveWins = 0;
        let openCount = 0;
        const livePnls: number[] = [];
        const catWins: Record<string, number> = {};
        const catCount: Record<string, number> = {};
        for (const t of trades) {
          const mkt = marketData.get(t.slug ?? "");
          if (!mkt) continue;
          // Map the trade's actual token id to its current price via clobTokenIds
          // (gamma normalizes binary outcomes to Yes/No, so outcome-label matching fails).
          const idx = mkt.clobTokenIds.indexOf(String(t.tokenId));
          if (idx < 0 || !(idx in mkt.outcomePrices)) continue;
          const cur = mkt.outcomePrices[idx];
          const entry = Number(t.price);
          const side = (t.side ?? "BUY").toUpperCase();
          // Wallet's position PnL direction: BUY profits if price rises, SELL if it falls.
          const favorable = side === "SELL" ? entry - cur : cur - entry;
          const end = mkt.endDate ? new Date(mkt.endDate).getTime() : NaN;
          const cat = categoryFromSlug(t.slug) ?? mkt.category;
          if (isNaN(end) || end >= now) {
            // open market → live directional signal
            openCount++;
            if (favorable > 0) liveWins++;
            livePnls.push(favorable * Number(t.size));
            if (cat) {
              catCount[cat] = (catCount[cat] || 0) + 1;
              if (favorable > 0) catWins[cat] = (catWins[cat] || 0) + 1;
            }
            continue;
          }
          // resolved market → historical signal
          histPnls.push(favorable * Number(t.size));
          const won = side === "SELL" ? cur < 0.5 : cur >= 0.5;
          if (won) wins++;
          resolvedCount++;
          if (cat) {
            catCount[cat] = (catCount[cat] || 0) + 1;
            if (won) catWins[cat] = (catWins[cat] || 0) + 1;
          }
          const entered = new Date(t.timestamp).getTime();
          entryTimings.push(Math.max(0, (end - entered) / 86_400_000));
        }
        const historicalWinRate = resolvedCount ? wins / resolvedCount : 0;
        const liveWinRate = openCount ? liveWins / openCount : 0;
        // Prefer historical when we have enough resolved trades; else live directional proxy.
        const winRate30d = resolvedCount >= 3 ? historicalWinRate : liveWinRate;
        const averageEntryTiming = entryTimings.length ? entryTimings.reduce((a, b) => a + b, 0) / entryTimings.length : 0;
        const pnlsForStats = resolvedCount >= 3 ? histPnls : livePnls;
        const returnVariance = (() => {
          if (pnlsForStats.length < 2) return 0;
          const mean = pnlsForStats.reduce((a, b) => a + b, 0) / pnlsForStats.length;
          const variance = pnlsForStats.reduce((a, b) => a + (b - mean) ** 2, 0) / pnlsForStats.length;
          const std = Math.sqrt(variance);
          return Math.min(1, Math.max(0, std / (Math.abs(mean) + 1e-6)));
        })();

        // Category edge = per-category win rate (live directional for open, historical for resolved).
        // Requires >=2 samples per category so a single lucky trade doesn't fake an edge.
        const categoryStrengths: Record<string, number> = {};
        for (const [cat, c] of Object.entries(catCount)) {
          if (c >= 2) categoryStrengths[cat] = catWins[cat] / c;
        }

        enriched = {
          tradeCount30d: tradeCount,
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

      // Adaptive penalty: wallets whose paper copies are losing money get demoted,
      // closing the loop so the bot deprioritizes bad wallets over time.
      const copyPnL = await prisma.paperTrade.aggregate({
        where: { walletAddress: p.address, status: 'open' },
        _sum: { unrealizedPnl: true }, _count: true,
      });
      const copyCount = copyPnL._count;
      const copyLoss = -(copyPnL._sum.unrealizedPnl ?? 0);
      let copyPenalty = 0;
      if (copyCount >= 3 && copyLoss > 0) {
        copyPenalty = Math.min(copyLoss * 5, 10); // 5pts/$1 loss, cap 10
      }
      const adjustedGlobal = Math.max(0, result.global - copyPenalty);

      // Per-wallet copy track record: if a wallet's copies lose money, stop tracking it
      // entirely (don't even monitor it). This closes the loop on bad wallets.
      const copyAgg = await prisma.paperTrade.aggregate({ where: { walletAddress: p.address }, _count: true, _avg: { unrealizedPnl: true } });
      let status: "track" | "watch" | "ignore";
      if (copyAgg._count >= 5 && (copyAgg._avg.unrealizedPnl ?? 0) < 0) {
        status = "ignore";
      } else {
        // Wallet status thresholds (separate from trade copyThreshold).
        // v1 scores cap ~60 (winRate + category are 0 — not collected yet),
        // so these are calibrated to the achievable range, not the SPEC's 70/50.
        status = adjustedGlobal >= 20 ? "track"
          : adjustedGlobal >= 10 ? "watch"
          : "ignore";
      }

      const bestCategory = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      await prisma.walletProfile.update({
        where: { id: p.id },
        data: {
          globalScore: adjustedGlobal,
          scoreComponentsJson: JSON.stringify(result.components),
          lastScannedAt: new Date(),
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
  console.log(`scanWallets done: ${profiles.length} wallets scored`);
}

if (require.main === module) runScanWallets().catch(console.error);
