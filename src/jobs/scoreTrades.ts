// Job: score:trades. Profit-ranked wallet-copy admission using executable CLOB economics.
// The fundamental strategy remains wallet copying. Uncertainty changes size; it does not
// automatically kill a coherent signal.
import { prisma } from "../lib/db.js";
import { scoreTradeByMarket, DEFAULT_RULES, getFavoriteGate, type RuleSetValues } from "../lib/scoring.js";
import { walletCopyCategory } from "../lib/walletCopyCategory.js";
import { closePaperTrade } from "../lib/paper.js";
import { getMarketBySlug, getExecutableBuyQuote, getExecutableSellQuote, type BuyQuote } from "../adapters/polymarket.js";

const NON_SPORTS_MAX_AGE_MS = 20 * 60 * 1000;
const SPORTS_MAX_AGE_MS = 45 * 60 * 1000;
const SPORTS_MIN_HOURS_TO_RESOLUTION = 1 / 6;
const SPORTS_MAX_DAYS_TO_RESOLUTION = 2;
const MAX_SPREAD_HARD_GATE = 0.05;
const MIN_PAPER_BET = 5;
const LOGIC_VERSION = "v5-profit-auction";

const STARTING_BANKROLL = Number(process.env.PAPER_BANKROLL ?? 300);
const MAX_DEPLOYED_FRACTION = Number(process.env.PAPER_MAX_DEPLOYED_FRACTION ?? 0.70);
const MAX_EVENT_FRACTION = Number(process.env.PAPER_MAX_EVENT_FRACTION ?? 0.10);
const MAX_CATEGORY_FRACTION = Number(process.env.PAPER_MAX_CATEGORY_FRACTION ?? MAX_DEPLOYED_FRACTION);
const MAX_WALLET_FRACTION = Number(process.env.PAPER_MAX_WALLET_FRACTION ?? 0.35);

interface Perf {
  count: number;
  pnl: number;
  stake: number;
  wins: number;
  openCount: number;
  openPnl: number;
}

type Tier = "A" | "B" | "C" | "DROP";

interface Candidate {
  observed: any;
  category: string | null;
  tier: Tier;
  rankScore: number;
  proposedBudget: number;
  quote: BuyQuote;
  marketScore: number;
  consensusWallets: number;
  signalDelaySec: number;
  reasons: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function key(wallet: string, marketId: string, tokenId: string | null): string {
  return `${wallet.toLowerCase()}|${marketId}|${tokenId ?? ""}`;
}

function perfRoi(perf: Perf | undefined): number {
  return perf && perf.stake > 0 ? (perf.pnl / perf.stake) * 100 : 0;
}

function perfWinRate(perf: Perf | undefined): number {
  return perf && perf.count > 0 ? perf.wins / perf.count : 0;
}

function tierFor(perf: Perf | undefined, walletGlobal: number): Tier {
  const count = perf?.count ?? 0;
  const pnl = perf?.pnl ?? 0;
  const roi = perfRoi(perf);
  const winRate = perfWinRate(perf);
  if (count >= 4 && pnl < 0 && (roi <= -3 || winRate < 0.40)) return "DROP";
  if (count >= 5 && pnl > 0 && roi >= 2 && winRate >= 0.55) return "A";
  if ((count >= 3 && pnl > 0 && winRate >= 0.50) || walletGlobal >= 45) return "B";
  return "C";
}

function tierFraction(tier: Tier): number {
  if (tier === "A") return 0.07;
  if (tier === "B") return 0.045;
  return 0.025;
}

function hoursToResolutionFromSlug(slug: string | null): number | null {
  if (!slug) return null;
  const match = slug.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) return null;
  const gameEnd = new Date(match[1] + "T05:00:00Z");
  gameEnd.setDate(gameEnd.getDate() + 1);
  return (gameEnd.getTime() - Date.now()) / 3_600_000;
}

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function writeDecision(observed: any, decision: string, reasons: string[], score = 0, size?: number): Promise<void> {
  await prisma.decisionJournal.create({
    data: {
      observedTradeId: observed.id,
      walletAddress: observed.walletAddress,
      marketId: observed.marketId,
      decision,
      copyScore: score,
      confidence: score > 0 ? clamp(score / 100, 0, 1) : null,
      simulatedPositionSize: size ?? null,
      reasonsJson: JSON.stringify([...reasons, `logic=${LOGIC_VERSION}`]),
      walletQualityScore: observed.wallet?.globalScore ?? 50,
    },
  });
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

  const unscored: any[] = await prisma.observedTrade.findMany({
    where: { decision: null },
    include: { wallet: true },
    orderBy: { timestamp: "desc" },
    take: 250,
  });
  if (!unscored.length) {
    console.log("scoreTrades: no unscored trades found");
    return;
  }

  const slugs: string[] = [...new Set<string>(
    unscored
      .map((trade: any) => trade.slug)
      .filter((slug: unknown): slug is string => typeof slug === "string" && slug.length > 0),
  )];
  const marketRows = await mapConcurrent(slugs, 8, async (slug) => {
    try { return [slug, await getMarketBySlug(slug)] as const; }
    catch { return [slug, null] as const; }
  });
  const marketBySlug = new Map(marketRows);

  const allCopies = await prisma.paperTrade.findMany({
    where: { source: "wallet_copy" },
    select: {
      id: true,
      walletAddress: true,
      marketId: true,
      slug: true,
      tokenId: true,
      outcome: true,
      side: true,
      entryPrice: true,
      currentPrice: true,
      simulatedPositionSize: true,
      unrealizedPnl: true,
      realizedPnl: true,
      status: true,
      openedAt: true,
      closedAt: true,
      resolvedAt: true,
    },
  });

  const walletPerf = new Map<string, Perf>();
  const categoryPerf = new Map<string, Perf>();
  const openByWalletToken = new Map<string, any>();
  const openWalletsByToken = new Map<string, Set<string>>();
  const eventExposure = new Map<string, number>();
  const categoryExposure = new Map<string, number>();
  const walletExposure = new Map<string, number>();

  let realizedPnl = 0;
  let unrealizedPnl = 0;
  let openDeployed = 0;

  const addPerf = (map: Map<string, Perf>, perfKey: string, copy: any) => {
    const row = map.get(perfKey) ?? { count: 0, pnl: 0, stake: 0, wins: 0, openCount: 0, openPnl: 0 };
    if (copy.status === "open") {
      row.openCount++;
      row.openPnl += copy.unrealizedPnl ?? 0;
    } else if (copy.realizedPnl != null) {
      row.count++;
      row.pnl += copy.realizedPnl;
      row.stake += copy.simulatedPositionSize ?? 0;
      if (copy.realizedPnl > 0) row.wins++;
    }
    map.set(perfKey, row);
  };

  for (const copy of allCopies) {
    const wallet = copy.walletAddress.toLowerCase();
    const category = walletCopyCategory(copy.slug) ?? `unknown:${copy.marketId}`;
    addPerf(walletPerf, wallet, copy);
    addPerf(categoryPerf, `${wallet}|${category}`, copy);
    if (copy.status === "open") {
      const size = copy.simulatedPositionSize ?? 0;
      openDeployed += size;
      unrealizedPnl += copy.unrealizedPnl ?? 0;
      openByWalletToken.set(key(copy.walletAddress, copy.marketId, copy.tokenId), copy);
      if (copy.tokenId) {
        const wallets = openWalletsByToken.get(copy.tokenId) ?? new Set<string>();
        wallets.add(wallet);
        openWalletsByToken.set(copy.tokenId, wallets);
      }
      eventExposure.set(copy.marketId, (eventExposure.get(copy.marketId) ?? 0) + size);
      categoryExposure.set(category, (categoryExposure.get(category) ?? 0) + size);
      walletExposure.set(wallet, (walletExposure.get(wallet) ?? 0) + size);
    } else {
      realizedPnl += copy.realizedPnl ?? 0;
    }
  }

  const equity = Math.max(1, STARTING_BANKROLL + realizedPnl + unrealizedPnl);
  let deployable = Math.max(0, equity * MAX_DEPLOYED_FRACTION - openDeployed);

  let exited = 0;
  let reductions = 0;
  let copied = 0;
  let scaled = 0;
  let skipped = 0;
  let displaced = 0;

  for (const observed of unscored.filter((trade) => (trade.side ?? "BUY").toUpperCase() === "SELL")) {
    const openKey = key(observed.walletAddress, observed.marketId, observed.tokenId);
    const open = openByWalletToken.get(openKey);
    if (!open || !observed.tokenId || !(open.entryPrice > 0) || !(open.simulatedPositionSize > 0)) {
      await writeDecision(observed, "skip", ["wallet SELL observed but no matching open wallet-copy position"]);
      skipped++;
      continue;
    }

    const priorFills = await prisma.observedTrade.findMany({
      where: {
        walletAddress: observed.walletAddress,
        tokenId: observed.tokenId,
        timestamp: { lte: observed.timestamp ?? new Date() },
        id: { not: observed.id },
      },
      select: { side: true, size: true },
    });
    const priorNetShares = priorFills.reduce((sum, fill) => {
      const size = fill.size ?? 0;
      return sum + ((fill.side ?? "BUY").toUpperCase() === "SELL" ? -size : size);
    }, 0);
    const sellFraction = clamp(
      (observed.size ?? 0) / Math.max(observed.size ?? 0, priorNetShares, 1e-9),
      0,
      1,
    );
    if (sellFraction < 0.50) {
      await writeDecision(observed, "watchlist", [
        `wallet reduced position by approximately ${(sellFraction * 100).toFixed(0)}%; below material-exit threshold`,
      ]);
      reductions++;
      continue;
    }

    const shares = open.simulatedPositionSize / open.entryPrice;
    let quote: Awaited<ReturnType<typeof getExecutableSellQuote>> = null;
    try { quote = await getExecutableSellQuote(observed.tokenId, shares); }
    catch { /* keep null */ }
    if (!quote) {
      await writeDecision(observed, "watchlist", ["material wallet SELL detected but executable exit quote unavailable"]);
      skipped++;
      continue;
    }

    const closed = closePaperTrade({
      walletAddress: open.walletAddress,
      marketId: open.marketId,
      outcome: open.outcome ?? "YES",
      side: open.side ?? "BUY",
      entryPrice: open.entryPrice,
      simulatedPositionSize: open.simulatedPositionSize,
      status: "open",
      currentPrice: open.currentPrice ?? open.entryPrice,
      unrealizedPnl: open.unrealizedPnl ?? 0,
      realizedPnl: null,
      openedAt: open.openedAt.getTime(),
      closedAt: null,
      resolvedAt: null,
    }, quote.netPrice);

    await prisma.paperTrade.update({
      where: { id: open.id },
      data: {
        currentPrice: quote.netPrice,
        unrealizedPnl: 0,
        realizedPnl: closed.realizedPnl,
        status: "closed",
        closedAt: new Date(closed.closedAt!),
      },
    });
    await prisma.pnlSnapshot.create({
      data: { paperTradeId: open.id, price: quote.netPrice, pnl: closed.realizedPnl },
    });
    await writeDecision(observed, "paper_exit", [
      `material wallet SELL ${(sellFraction * 100).toFixed(0)}%`,
      `executableNetExit=${quote.netPrice.toFixed(4)}`,
      `realizedPnl=$${(closed.realizedPnl ?? 0).toFixed(2)}`,
    ], 100);

    const size = open.simulatedPositionSize;
    const category = walletCopyCategory(open.slug) ?? `unknown:${open.marketId}`;
    deployable += size;
    eventExposure.set(open.marketId, Math.max(0, (eventExposure.get(open.marketId) ?? 0) - size));
    categoryExposure.set(category, Math.max(0, (categoryExposure.get(category) ?? 0) - size));
    walletExposure.set(
      open.walletAddress.toLowerCase(),
      Math.max(0, (walletExposure.get(open.walletAddress.toLowerCase()) ?? 0) - size),
    );
    openByWalletToken.delete(openKey);
    openWalletsByToken.get(observed.tokenId)?.delete(observed.walletAddress.toLowerCase());
    exited++;
  }

  const buys: any[] = unscored.filter((trade: any) => (trade.side ?? "BUY").toUpperCase() === "BUY");
  const freshWalletsByToken = new Map<string, Set<string>>();
  for (const trade of buys) {
    if (!trade.tokenId) continue;
    const wallet = trade.walletAddress.toLowerCase();
    const tier = tierFor(walletPerf.get(wallet), trade.wallet?.globalScore ?? 35);
    if (tier === "DROP") continue;
    const wallets = freshWalletsByToken.get(trade.tokenId) ?? new Set<string>();
    wallets.add(wallet);
    freshWalletsByToken.set(trade.tokenId, wallets);
  }

  const prepared = await mapConcurrent(buys, 5, async (observed): Promise<Candidate | null> => {
    const walletGlobal = observed.wallet?.globalScore ?? 35;
    const walletKey = observed.walletAddress.toLowerCase();
    const perf = walletPerf.get(walletKey);
    const tier = tierFor(perf, walletGlobal);
    if (tier === "DROP") {
      await writeDecision(observed, "skip", [
        `resolved wallet-copy evidence is materially negative: ${perf?.count ?? 0} settled, ROI ${perfRoi(perf).toFixed(1)}%, win ${(perfWinRate(perf) * 100).toFixed(0)}%`,
      ]);
      skipped++;
      return null;
    }

    const market = observed.slug ? marketBySlug.get(observed.slug) : null;
    const category = walletCopyCategory(observed.slug, observed.marketCategory ?? market?.category);
    const isSports = category === "sports";
    const maxAge = isSports ? SPORTS_MAX_AGE_MS : NON_SPORTS_MAX_AGE_MS;
    const signalAge = observed.timestamp
      ? Math.max(0, Date.now() - observed.timestamp.getTime())
      : Infinity;
    if (signalAge > maxAge) {
      await writeDecision(observed, "skip", [
        `signal age ${(signalAge / 60000).toFixed(0)}min exceeds opportunity window ${(maxAge / 60000).toFixed(0)}min`,
      ]);
      skipped++;
      return null;
    }
    if (!observed.tokenId) {
      await writeDecision(observed, "skip", ["no tokenId; executable CLOB economics unavailable"]);
      skipped++;
      return null;
    }
    if (market && (market.closed || !market.active || !market.acceptingOrders)) {
      await writeDecision(observed, "skip", ["market is closed or not accepting orders"]);
      skipped++;
      return null;
    }

    const idx = market?.clobTokenIds.indexOf(String(observed.tokenId)) ?? -1;
    const midpoint = idx >= 0 && market && idx in market.outcomePrices
      ? market.outcomePrices[idx]
      : observed.detectedPrice ?? 0.5;
    const detectedPrice = observed.walletEntryPrice ?? observed.detectedPrice ?? midpoint;
    const liquidity = observed.marketLiquidity ?? market?.liquidity ?? 10_000;
    const spread = observed.marketSpread ?? market?.spread ?? 0.03;
    const volume = market?.volume ?? 0;

    let actualDays = market?.endDate
      ? (new Date(market.endDate).getTime() - Date.now()) / 86_400_000
      : 30;
    let scoringDays = Math.max(actualDays, rules.minDaysToResolution);
    if (isSports) {
      const hours = market?.endDate
        ? (new Date(market.endDate).getTime() - Date.now()) / 3_600_000
        : hoursToResolutionFromSlug(observed.slug);
      if (hours == null || hours < SPORTS_MIN_HOURS_TO_RESOLUTION || hours > SPORTS_MAX_DAYS_TO_RESOLUTION * 24) {
        await writeDecision(observed, "skip", [
          hours == null
            ? "sports timing unavailable"
            : `sports resolution horizon ${hours.toFixed(1)}h outside executable window`,
        ]);
        skipped++;
        return null;
      }
      actualDays = hours / 24;
      scoringDays = rules.minDaysToResolution;
    }

    if (spread > MAX_SPREAD_HARD_GATE) {
      await writeDecision(observed, "skip", [
        `market spread ${(spread * 100).toFixed(1)}% exceeds ${MAX_SPREAD_HARD_GATE * 100}%`,
      ]);
      skipped++;
      return null;
    }

    const scoringLiquidity = rules.maxMarketLiquidity > 0
      ? Math.min(liquidity, rules.maxMarketLiquidity)
      : liquidity;
    const scoringVolume = scoringLiquidity > 0
      ? Math.min(volume, scoringLiquidity * rules.toxicRatio)
      : volume;
    const marketResult = scoreTradeByMarket({
      side: "BUY",
      currentPrice: midpoint,
      priceMovementSinceEntry: Math.max(0, midpoint - detectedPrice),
      spread,
      liquidity: scoringLiquidity,
      volume: scoringVolume,
      daysToResolution: scoringDays,
      detectedPrice,
    }, rules);
    if (marketResult.skip) {
      await writeDecision(observed, "skip", marketResult.reasons);
      skipped++;
      return null;
    }

    const categoryEvidence = categoryPerf.get(`${walletKey}|${category ?? `unknown:${observed.marketId}`}`);
    const existing = openByWalletToken.get(key(observed.walletAddress, observed.marketId, observed.tokenId));
    const consensusWallets = Math.max(
      freshWalletsByToken.get(observed.tokenId)?.size ?? 1,
      openWalletsByToken.get(observed.tokenId)?.size ?? 0,
    );
    const baseFraction = tierFraction(tier);
    const consensusMultiplier = consensusWallets >= 3 ? 1.40 : consensusWallets === 2 ? 1.25 : 1;
    const proposedBudget = round(
      equity * baseFraction * consensusMultiplier * (existing ? 0.50 : 1),
    );

    let quote: Awaited<ReturnType<typeof getExecutableBuyQuote>> = null;
    try {
      quote = await getExecutableBuyQuote(
        observed.tokenId,
        Math.max(MIN_PAPER_BET, proposedBudget),
      );
    } catch { /* keep null */ }
    if (!quote) {
      await writeDecision(observed, "skip", [
        `no executable CLOB quote for $${Math.max(MIN_PAPER_BET, proposedBudget).toFixed(2)}`,
      ]);
      skipped++;
      return null;
    }

    const gate = getFavoriteGate(category);
    if (quote.allInPrice < gate || quote.allInPrice > rules.topThreshold) {
      await writeDecision(observed, "skip", [
        `executable all-in ${quote.allInPrice.toFixed(4)} outside category opportunity band ${gate.toFixed(2)}-${rules.topThreshold.toFixed(2)}`,
      ]);
      skipped++;
      return null;
    }
    if (quote.spread != null && quote.spread > MAX_SPREAD_HARD_GATE) {
      await writeDecision(observed, "skip", [
        `executable spread ${(quote.spread * 100).toFixed(1)}% exceeds ${MAX_SPREAD_HARD_GATE * 100}%`,
      ]);
      skipped++;
      return null;
    }
    const entryDeterioration = quote.allInPrice - detectedPrice;
    if (entryDeterioration > rules.maxEntryGap) {
      await writeDecision(observed, "skip", [
        `executable price deterioration ${entryDeterioration.toFixed(3)} exceeds ${rules.maxEntryGap}`,
      ]);
      skipped++;
      return null;
    }

    const walletEvidence = perf?.count
      ? clamp(50 + perfRoi(perf) * 2 + (perfWinRate(perf) - 0.5) * 60, 20, 95)
      : clamp(walletGlobal, 25, 75);
    const categoryEvidenceScore = categoryEvidence?.count
      ? clamp(50 + perfRoi(categoryEvidence) * 2 + (perfWinRate(categoryEvidence) - 0.5) * 60, 20, 95)
      : 50;
    const entryScore = clamp(100 - Math.max(0, entryDeterioration) * 1_500, 0, 100);
    const spreadScore = clamp(100 - (quote.spread ?? 0) * 2_000, 0, 100);
    const delayScore = clamp(100 * (1 - signalAge / maxAge), 0, 100);
    const favoriteScore = clamp(
      ((quote.allInPrice - gate) / Math.max(0.01, rules.topThreshold - gate)) * 100,
      0,
      100,
    );
    const lockScore = isSports
      ? clamp(100 - actualDays * 20, 50, 100)
      : clamp(100 - actualDays, 20, 90);
    const consensusBonus = Math.min(12, Math.max(0, consensusWallets - 1) * 6);
    const rankScore = round(
      0.30 * walletEvidence
      + 0.15 * categoryEvidenceScore
      + 0.18 * marketResult.score
      + 0.15 * entryScore
      + 0.08 * spreadScore
      + 0.05 * delayScore
      + 0.05 * favoriteScore
      + 0.04 * lockScore
      + consensusBonus,
      1,
    );

    return {
      observed,
      category,
      tier,
      rankScore,
      proposedBudget,
      quote,
      marketScore: marketResult.score,
      consensusWallets,
      signalDelaySec: signalAge / 1000,
      reasons: [
        ...marketResult.reasons,
        `tier=${tier}`,
        `resolvedCopyCount=${perf?.count ?? 0}`,
        `resolvedCopyRoi=${perfRoi(perf).toFixed(1)}%`,
        `categoryCopyCount=${categoryEvidence?.count ?? 0}`,
        `consensusWallets=${consensusWallets}`,
        `rankScore=${rankScore}`,
      ],
    };
  });

  const candidates = prepared
    .filter((candidate): candidate is Candidate => candidate != null)
    .sort((a, b) => b.rankScore - a.rankScore || a.signalDelaySec - b.signalDelaySec);

  for (const candidate of candidates) {
    const { observed, quote, category, tier } = candidate;
    const wallet = observed.walletAddress.toLowerCase();
    const positionKey = key(observed.walletAddress, observed.marketId, observed.tokenId);
    const existing = openByWalletToken.get(positionKey);

    const walletNotional = (observed.size ?? 0)
      * (observed.walletEntryPrice ?? observed.detectedPrice ?? quote.allInPrice);
    if (existing && walletNotional < Math.max(10, (existing.simulatedPositionSize ?? 0) * 0.50)) {
      await writeDecision(observed, "watchlist", [
        ...candidate.reasons,
        `same-wallet fill $${walletNotional.toFixed(2)} is too small to represent a meaningful scale-in`,
      ], candidate.rankScore);
      skipped++;
      continue;
    }

    const baseBudget = existing
      ? Math.min(candidate.proposedBudget, equity * tierFraction(tier) * 0.50)
      : candidate.proposedBudget;
    const eventRoom = Math.max(
      0,
      equity * MAX_EVENT_FRACTION - (eventExposure.get(observed.marketId) ?? 0),
    );
    const categoryKey = category ?? `unknown:${observed.marketId}`;
    const categoryRoom = Math.max(
      0,
      equity * MAX_CATEGORY_FRACTION - (categoryExposure.get(categoryKey) ?? 0),
    );
    const walletRoom = Math.max(
      0,
      equity * MAX_WALLET_FRACTION - (walletExposure.get(wallet) ?? 0),
    );
    const budget = round(Math.min(baseBudget, deployable, eventRoom, categoryRoom, walletRoom));

    if (budget < MIN_PAPER_BET) {
      await writeDecision(observed, "watchlist", [
        ...candidate.reasons,
        `positive candidate displaced by stronger deployed opportunities; available allocation $${budget.toFixed(2)}`,
      ], candidate.rankScore);
      displaced++;
      continue;
    }

    let finalQuote = quote;
    if (Math.abs(budget - candidate.proposedBudget) > 0.01) {
      try {
        const resized = await getExecutableBuyQuote(observed.tokenId, budget);
        if (resized) finalQuote = resized;
        else finalQuote = {
          ...quote,
          shares: budget / quote.allInPrice,
          cashCost: budget,
          fee: quote.cashCost > 0 ? quote.fee * (budget / quote.cashCost) : 0,
        };
      } catch {
        finalQuote = {
          ...quote,
          shares: budget / quote.allInPrice,
          cashCost: budget,
          fee: quote.cashCost > 0 ? quote.fee * (budget / quote.cashCost) : 0,
        };
      }
    }

    const decision = existing ? "paper_scale_in" : "paper_copy";
    const decisionJournal = await prisma.decisionJournal.create({
      data: {
        observedTradeId: observed.id,
        walletAddress: observed.walletAddress,
        marketId: observed.marketId,
        decision,
        copyScore: candidate.rankScore,
        confidence: clamp(candidate.rankScore / 100, 0, 1),
        simulatedPositionSize: budget,
        reasonsJson: JSON.stringify([
          ...candidate.reasons,
          `logic=${LOGIC_VERSION}`,
          `signalDelay=${candidate.signalDelaySec.toFixed(0)}s`,
          `bestAsk=${finalQuote.bestAsk.toFixed(4)}`,
          `allInPrice=${finalQuote.allInPrice.toFixed(4)}`,
          `fee=${finalQuote.fee.toFixed(4)}`,
          `spread=${(finalQuote.spread ?? 0).toFixed(4)}`,
          `allocated=$${budget.toFixed(2)}`,
          `shares=${finalQuote.shares.toFixed(2)}`,
        ]),
        walletQualityScore: observed.wallet?.globalScore ?? 35,
      },
    });

    if (existing) {
      const oldCash = existing.simulatedPositionSize ?? 0;
      const oldEntry = existing.entryPrice ?? finalQuote.allInPrice;
      const oldShares = oldEntry > 0 ? oldCash / oldEntry : 0;
      const totalCash = oldCash + budget;
      const totalShares = oldShares + finalQuote.shares;
      const averageEntry = totalShares > 0 ? totalCash / totalShares : finalQuote.allInPrice;
      const markPnl = oldShares * (finalQuote.allInPrice - oldEntry);
      const updated = await prisma.paperTrade.update({
        where: { id: existing.id },
        data: {
          entryPrice: averageEntry,
          currentPrice: finalQuote.allInPrice,
          simulatedPositionSize: totalCash,
          unrealizedPnl: round(markPnl),
        },
      });
      openByWalletToken.set(positionKey, updated);
      scaled++;
    } else {
      const created = await prisma.paperTrade.create({
        data: {
          decisionJournalId: decisionJournal.id,
          walletAddress: observed.walletAddress,
          marketId: observed.marketId,
          slug: observed.slug ?? null,
          tokenId: observed.tokenId,
          outcome: observed.outcome ?? "YES",
          side: "BUY",
          entryPrice: finalQuote.allInPrice,
          currentPrice: finalQuote.allInPrice,
          simulatedPositionSize: budget,
          unrealizedPnl: 0,
          realizedPnl: null,
          status: "open",
          source: "wallet_copy",
          openedAt: new Date(),
        },
      });
      openByWalletToken.set(positionKey, created);
      const wallets = openWalletsByToken.get(observed.tokenId) ?? new Set<string>();
      wallets.add(wallet);
      openWalletsByToken.set(observed.tokenId, wallets);
      copied++;
    }

    deployable -= budget;
    eventExposure.set(observed.marketId, (eventExposure.get(observed.marketId) ?? 0) + budget);
    categoryExposure.set(categoryKey, (categoryExposure.get(categoryKey) ?? 0) + budget);
    walletExposure.set(wallet, (walletExposure.get(wallet) ?? 0) + budget);
    console.log(
      `  ${decision.toUpperCase()}: ${observed.slug?.slice(0, 35)} tier=${tier} rank=${candidate.rankScore.toFixed(1)} `
      + `@ ${finalQuote.allInPrice.toFixed(4)} $${budget.toFixed(2)} consensus=${candidate.consensusWallets}`,
    );
  }

  console.log(
    `scoreTrades done: ${unscored.length} signals; ${copied} entries, ${scaled} scale-ins, ${exited} wallet exits, `
    + `${reductions} small reductions, ${displaced} capital-displaced, ${skipped} skipped; `
    + `equity=$${equity.toFixed(2)} deployed=$${openDeployed.toFixed(2)} remainingAuction=$${deployable.toFixed(2)}`,
  );
}

if (require.main === module) runScoreTrades().catch(console.error);
