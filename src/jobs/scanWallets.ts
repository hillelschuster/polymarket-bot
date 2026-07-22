// Job: scan:wallets. Rank wallet opportunity quality without letting temporary open PnL kill alpha.
import { prisma } from "../lib/db.js";
import { scoreWallet, DEFAULT_RULES, categoryFromSlug, type WalletInput } from "../lib/scoring.js";
import { getLeaderboard } from "../adapters/leaderboard.js";
import { getWalletTrades } from "../adapters/trades.js";
import { getMarketBySlug } from "../adapters/polymarket.js";
import { isLive } from "../lib/config.js";

const ENRICH_BATCH = 12;
const ENRICH_MAX_AGE_MS = 30 * 60 * 1000;
const PUBLIC_TRADES_PER_WALLET = 100;

type CopyEvidence = { count: number; pnl: number; stake: number; wins: number };

function resolvedTier(evidence: CopyEvidence | undefined): "A" | "B" | "C" | "DROP" {
  if (!evidence || evidence.count === 0) return "C";
  const roi = evidence.stake > 0 ? (evidence.pnl / evidence.stake) * 100 : 0;
  const winRate = evidence.wins / evidence.count;
  if (evidence.count >= 4 && evidence.pnl < 0 && (roi <= -3 || winRate < 0.40)) return "DROP";
  if (evidence.count >= 5 && evidence.pnl > 0 && roi >= 2 && winRate >= 0.55) return "A";
  if (evidence.count >= 3 && evidence.pnl > 0 && winRate >= 0.50) return "B";
  return "C";
}

export async function runScanWallets(): Promise<void> {
  const profiles = await prisma.walletProfile.findMany({
    orderBy: { sourceRank: { sort: "asc", nulls: "last" } },
  });
  if (!profiles.length) {
    console.log("scanWallets: no profiles found, skipping");
    return;
  }

  let leaderboard = new Map<string, { totalPnl: number; volume: number; roi: number }>();
  if (isLive) {
    const rows = await getLeaderboard({ limit: 50 });
    leaderboard = new Map(rows.map((row) => [row.id.toLowerCase(), {
      totalPnl: row.totalPnl,
      volume: row.volume,
      roi: row.roi,
    }]));
  }

  const settledCopies = await prisma.paperTrade.findMany({
    where: { source: "wallet_copy", status: { not: "open" } },
    select: { walletAddress: true, simulatedPositionSize: true, realizedPnl: true },
  });
  const copyByWallet = new Map<string, CopyEvidence>();
  for (const copy of settledCopies) {
    if (copy.realizedPnl == null) continue;
    const wallet = copy.walletAddress.toLowerCase();
    const evidence = copyByWallet.get(wallet) ?? { count: 0, pnl: 0, stake: 0, wins: 0 };
    evidence.count++;
    evidence.pnl += copy.realizedPnl;
    evidence.stake += copy.simulatedPositionSize ?? 0;
    if (copy.realizedPnl > 0) evidence.wins++;
    copyByWallet.set(wallet, evidence);
  }

  const now = Date.now();
  const enrichIds = new Set(
    profiles
      .filter((profile) => profile.sourceRank != null && profile.sourceRank <= 50)
      .sort((a, b) => (a.lastScannedAt?.getTime() ?? 0) - (b.lastScannedAt?.getTime() ?? 0))
      .filter((profile) => !profile.lastScannedAt || now - profile.lastScannedAt.getTime() > ENRICH_MAX_AGE_MS)
      .slice(0, ENRICH_BATCH)
      .map((profile) => profile.id),
  );

  const marketPromises = new Map<string, ReturnType<typeof getMarketBySlug>>();
  const marketFor = (slug: string) => {
    let promise = marketPromises.get(slug);
    if (!promise) {
      promise = getMarketBySlug(slug).catch(() => null);
      marketPromises.set(slug, promise);
    }
    return promise;
  };

  for (const profile of profiles) {
    try {
      const lb = leaderboard.get(profile.address.toLowerCase());
      const shouldEnrich = isLive && enrichIds.has(profile.id);
      let enriched: Partial<WalletInput> = {};

      if (shouldEnrich) {
        const trades = await getWalletTrades(profile.address, { limit: PUBLIC_TRADES_PER_WALLET });
        const slugs = [...new Set(trades.map((trade) => trade.slug).filter((slug): slug is string => Boolean(slug)))];
        await Promise.all(slugs.map((slug) => marketFor(slug)));

        const marketRows = new Map<string, NonNullable<Awaited<ReturnType<typeof getMarketBySlug>>>>();
        for (const slug of slugs) {
          const market = await marketFor(slug);
          if (market) marketRows.set(slug, market);
        }

        const availableMarkets = trades
          .map((trade) => marketRows.get(trade.slug ?? ""))
          .filter((market): market is NonNullable<typeof market> => Boolean(market));
        const averageLiquidity = availableMarkets.length
          ? availableMarkets.reduce((sum, market) => sum + market.liquidity, 0) / availableMarkets.length
          : 0;
        const averageSpread = availableMarkets.length
          ? availableMarkets.reduce((sum, market) => sum + market.spread, 0) / availableMarkets.length
          : 0;

        const historicalPnls: number[] = [];
        const livePnls: number[] = [];
        const entryTimings: number[] = [];
        let historicalWins = 0;
        let resolvedCount = 0;
        let liveWins = 0;
        let openCount = 0;
        const categoryWins: Record<string, number> = {};
        const categoryCounts: Record<string, number> = {};

        for (const trade of trades) {
          const market = marketRows.get(trade.slug ?? "");
          if (!market) continue;
          const tokenIndex = market.clobTokenIds.indexOf(String(trade.tokenId));
          if (tokenIndex < 0 || !(tokenIndex in market.outcomePrices)) continue;
          const current = market.outcomePrices[tokenIndex];
          const entry = Number(trade.price);
          const side = (trade.side ?? "BUY").toUpperCase();
          const favorable = side === "SELL" ? entry - current : current - entry;
          const endTime = market.endDate ? new Date(market.endDate).getTime() : NaN;
          const category = categoryFromSlug(trade.slug) ?? market.category;

          if (Number.isNaN(endTime) || endTime >= now) {
            openCount++;
            livePnls.push(favorable * Number(trade.size));
            if (favorable > 0) liveWins++;
            continue;
          }

          resolvedCount++;
          historicalPnls.push(favorable * Number(trade.size));
          const won = side === "SELL" ? current < 0.5 : current >= 0.5;
          if (won) historicalWins++;
          if (category) {
            categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
            if (won) categoryWins[category] = (categoryWins[category] ?? 0) + 1;
          }
          entryTimings.push(Math.max(0, (endTime - trade.timestamp * 1000) / 86_400_000));
        }

        const historicalWinRate = resolvedCount ? historicalWins / resolvedCount : 0;
        const liveWinRate = openCount ? liveWins / openCount : 0;
        const winRate30d = resolvedCount >= 3 ? historicalWinRate : liveWinRate;
        const statsPnls = resolvedCount >= 3 ? historicalPnls : livePnls;
        const returnVariance = (() => {
          if (statsPnls.length < 2) return 0;
          const mean = statsPnls.reduce((sum, pnl) => sum + pnl, 0) / statsPnls.length;
          const variance = statsPnls.reduce((sum, pnl) => sum + (pnl - mean) ** 2, 0) / statsPnls.length;
          return Math.min(1, Math.sqrt(variance) / (Math.abs(mean) + 1e-6));
        })();
        const categoryStrengths: Record<string, number> = {};
        for (const [category, count] of Object.entries(categoryCounts)) {
          if (count >= 2) categoryStrengths[category] = (categoryWins[category] ?? 0) / count;
        }

        enriched = {
          tradeCount30d: trades.length,
          averageLiquidity,
          averageSpread,
          categoryStrengths,
          resolvedTradeCount30d: resolvedCount,
          winRate30d,
          averageEntryTiming: entryTimings.length
            ? entryTimings.reduce((sum, days) => sum + days, 0) / entryTimings.length
            : 0,
          tradePnls: resolvedCount >= 3 ? historicalPnls : [],
          returnVariance,
        };
      }

      const categories: Record<string, number> = (enriched.categoryStrengths
        ?? (profile.categoryStrengthsJson ? JSON.parse(profile.categoryStrengthsJson) : {})) as Record<string, number>;
      const input: WalletInput = {
        roi30d: lb?.roi ?? profile.roi30d ?? 0,
        winRate30d: enriched.winRate30d ?? profile.winRate30d ?? 0,
        resolvedTradeCount30d: enriched.resolvedTradeCount30d ?? profile.resolvedTradeCount30d ?? 0,
        tradeCount30d: enriched.tradeCount30d ?? profile.tradeCount30d ?? 0,
        averageLiquidity: enriched.averageLiquidity ?? profile.averageLiquidity ?? 0,
        averageSpread: enriched.averageSpread ?? profile.averageSpread ?? 0,
        averageEntryTiming: enriched.averageEntryTiming ?? profile.averageEntryTiming ?? 0,
        categoryStrengths: categories,
        tradePnls: enriched.tradePnls ?? [],
        returnVariance: enriched.returnVariance ?? 0,
      };
      const score = scoreWallet(input, DEFAULT_RULES);
      const evidence = copyByWallet.get(profile.address.toLowerCase());
      const tier = resolvedTier(evidence);
      const copyRoi = evidence && evidence.stake > 0 ? (evidence.pnl / evidence.stake) * 100 : 0;
      const copyWin = evidence?.count ? evidence.wins / evidence.count : 0;

      // Only materially negative realized evidence removes a wallet. Uncertainty stays observable.
      let status: "track" | "watch" | "ignore";
      if (tier === "DROP") status = "ignore";
      else if (tier === "A" || tier === "B" || score.global >= 20) status = "track";
      else status = "watch";

      const bestCategory = Object.entries(categories).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      await prisma.walletProfile.update({
        where: { id: profile.id },
        data: {
          globalScore: score.global,
          scoreComponentsJson: JSON.stringify(score.components),
          lastScannedAt: new Date(),
          status,
          roi30d: lb?.roi ?? profile.roi30d,
          tradeCount30d: input.tradeCount30d,
          resolvedTradeCount30d: input.resolvedTradeCount30d,
          winRate30d: input.winRate30d,
          averageLiquidity: input.averageLiquidity,
          averageSpread: input.averageSpread,
          averageEntryTiming: input.averageEntryTiming,
          categoryStrengthsJson: JSON.stringify(categories),
          bestCategory,
          averageTradeSize: profile.averageTradeSize
            ?? (lb?.volume != null && input.tradeCount30d ? lb.volume / input.tradeCount30d : null),
          riskNotes: `copyTier=${tier}; settled=${evidence?.count ?? 0}; copyPnl=${(evidence?.pnl ?? 0).toFixed(2)}; copyRoi=${copyRoi.toFixed(1)}%; copyWin=${(copyWin * 100).toFixed(0)}%`,
        },
      });
    } catch (error) {
      console.error(`scanWallets: error processing wallet ${profile.address}:`, error);
    }
  }

  console.log(`scanWallets done: ${profiles.length} wallets scored; temporary open PnL cannot blacklist wallets`);
}

if (require.main === module) runScanWallets().catch(console.error);
