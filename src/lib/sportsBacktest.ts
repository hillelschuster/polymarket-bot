export interface HistoricalTrade {
  asset: string;
  side: string;
  size: number;
  price: number;
  timestamp: number;
}

export interface FavoriteAtEntry {
  tokenId: string;
  outcomeIndex: number;
  referencePrice: number;
  tokenPrices: number[];
}

export interface SimulatedFill {
  shares: number;
  cashSpent: number;
  feePaid: number;
  averagePrice: number;
  allInPrice: number;
  fillRatio: number;
  fillSeconds: number;
  tradeCount: number;
}

export interface BacktestRow {
  sport: string;
  marketId: string;
  conditionId: string;
  slug: string;
  gameId: string | null;
  eventStartTime: string;
  favoriteOutcome: string;
  favoriteTokenId: string;
  referencePrice: number;
  averageFillPrice: number;
  allInPrice: number;
  feePaid: number;
  shares: number;
  cashSpent: number;
  fillRatio: number;
  fillSeconds: number;
  won: boolean;
  pnl: number;
  roi: number;
}

export interface BacktestSummary {
  n: number;
  wins: number;
  winRate: number;
  cashSpent: number;
  pnl: number;
  roi: number;
  averageTradeRoi: number;
  ci95Low: number;
  ci95High: number;
}

export function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return value.split(",").map((x) => x.trim()).filter(Boolean);
  }
}

/** Gamma feeSchedule.rate is decimal; older fields may be basis points. */
export function normalizeFeeRate(value: unknown, fallback = 0.03): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n > 1 ? n / 10_000 : n;
}

export function takerFeePerShare(price: number, feeRate: number): number {
  return price * (1 - price) * feeRate;
}

/** Uses only information timestamped at or before entry. */
export function favoriteAtEntry(
  trades: HistoricalTrade[],
  tokenIds: string[],
  entryTs: number,
  maxPriceAgeSeconds: number,
): FavoriteAtEntry | null {
  if (tokenIds.length !== 2) return null;
  const latest = new Map<string, HistoricalTrade>();
  const floor = entryTs - maxPriceAgeSeconds;
  for (const trade of trades) {
    if (!tokenIds.includes(trade.asset)) continue;
    if (trade.timestamp < floor || trade.timestamp > entryTs) continue;
    if (!(trade.price > 0 && trade.price < 1)) continue;
    const prior = latest.get(trade.asset);
    if (!prior || trade.timestamp > prior.timestamp) latest.set(trade.asset, trade);
  }
  const prices = tokenIds.map((id) => latest.get(id)?.price ?? Number.NaN);
  if (prices.some((p) => !Number.isFinite(p))) return null;
  const outcomeIndex = prices[0] >= prices[1] ? 0 : 1;
  return {
    tokenId: tokenIds[outcomeIndex],
    outcomeIndex,
    referencePrice: prices[outcomeIndex],
    tokenPrices: prices,
  };
}

/**
 * Conservative historical execution proxy:
 * consume subsequent taker BUY prints, add one tick to every observed price,
 * and require the caller to enforce a minimum fill ratio.
 */
export function simulateTakerBuy(
  trades: HistoricalTrade[],
  tokenId: string,
  entryTs: number,
  fillWindowSeconds: number,
  cashBudget: number,
  feeRate: number,
  tickSize: number,
): SimulatedFill | null {
  if (!(cashBudget > 0) || !(tickSize > 0)) return null;
  const candidates = trades
    .filter((t) =>
      t.asset === tokenId &&
      t.side.toUpperCase() === "BUY" &&
      t.timestamp >= entryTs &&
      t.timestamp <= entryTs + fillWindowSeconds &&
      t.size > 0 &&
      t.price > 0 &&
      t.price < 1,
    )
    .sort((a, b) => a.timestamp - b.timestamp);

  let remainingCash = cashBudget;
  let shares = 0;
  let notional = 0;
  let feePaid = 0;
  let lastFillTs = entryTs;
  let tradeCount = 0;

  for (const trade of candidates) {
    const executionPrice = Math.min(0.9999, trade.price + tickSize);
    const feePerShare = takerFeePerShare(executionPrice, feeRate);
    const allInPerShare = executionPrice + feePerShare;
    const take = Math.min(trade.size, remainingCash / allInPerShare);
    if (!(take > 0)) continue;
    shares += take;
    notional += take * executionPrice;
    feePaid += take * feePerShare;
    remainingCash -= take * allInPerShare;
    lastFillTs = trade.timestamp;
    tradeCount++;
    if (remainingCash <= 0.001) break;
  }

  if (!(shares > 0)) return null;
  const cashSpent = notional + feePaid;
  return {
    shares,
    cashSpent,
    feePaid,
    averagePrice: notional / shares,
    allInPrice: cashSpent / shares,
    fillRatio: cashSpent / cashBudget,
    fillSeconds: Math.max(0, lastFillTs - entryTs),
    tradeCount,
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

export function bootstrapMeanCI(values: number[], iterations = 5_000, seed = 0x5eed): [number, number] {
  if (!values.length) return [0, 0];
  if (values.length === 1) return [values[0], values[0]];
  const random = seededRandom(seed);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < values.length; j++) {
      total += values[Math.floor(random() * values.length)];
    }
    samples.push(total / values.length);
  }
  samples.sort((a, b) => a - b);
  return [samples[Math.floor(iterations * 0.025)], samples[Math.floor(iterations * 0.975)]];
}

export function summarizeBacktest(rows: BacktestRow[]): BacktestSummary {
  const cashSpent = rows.reduce((sum, row) => sum + row.cashSpent, 0);
  const pnl = rows.reduce((sum, row) => sum + row.pnl, 0);
  const tradeRois = rows.map((row) => row.roi);
  const [ci95Low, ci95High] = bootstrapMeanCI(tradeRois);
  const wins = rows.filter((row) => row.won).length;
  return {
    n: rows.length,
    wins,
    winRate: rows.length ? wins / rows.length : 0,
    cashSpent,
    pnl,
    roi: cashSpent ? pnl / cashSpent : 0,
    averageTradeRoi: mean(tradeRois),
    ci95Low,
    ci95High,
  };
}
