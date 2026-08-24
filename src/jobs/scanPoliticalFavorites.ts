// Electoral-political favorites. Paper entries use executable CLOB depth + taker fees.
import { prisma } from "../lib/db.js";
import { realTradingEnabled } from "../lib/config.js";
import {
  getActiveMarkets,
  getOrderBook,
  type GammaMarket,
  type OrderBook,
} from "../adapters/polymarket.js";
import { getFeeModel, type FeeModel } from "../adapters/marketFees.js";
import { quoteBuyWithCash, quoteSellSharesExact } from "../lib/executableQuotes.js";
import { categoryFromSlug } from "../lib/scoring.js";

const STRATEGY_NAME = "political_favorites";
const POSITION_SIZE = 10;
export const MIN_FAVORITE_PRICE = 0.65;
export const MAX_FAVORITE_PRICE = 0.82;
export const MIN_LIQUIDITY = 10_000;
export const MAX_LIQUIDITY = 500_000;
export const MAX_SPREAD = 0.02;
export const MIN_DAYS_TO_RESOLUTION = 1;
export const MAX_DAYS_TO_RESOLUTION = 90;
const MIN_NET_EDGE = 0.01;
const MAX_TOXIC_RATIO = 15;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const POLITICAL_CALIBRATION_SLOPE = 1.31;

const POLITICAL_PREFIXES = new Set([
  "politics", "political", "election", "president", "presidential",
  "senate", "congress", "governor", "mayor", "referendum", "ballot",
  "trump", "biden", "democrat", "republican", "gop", "dnc", "rnc",
  "supreme-court", "scotus", "impeach", "cabinet", "nominee",
  "primary", "caucus", "incumbent", "challenger", "poll", "polls",
]);

const EXCLUSION_KEYWORDS = new Set([
  "fed", "federal-reserve", "interest-rate", "rates", "fomc", "powell",
  "inflation", "gdp", "unemployment", "treasury", "bond", "monetary",
]);

function isPoliticalMarket(m: GammaMarket): boolean {
  const slug = m.slug?.toLowerCase() ?? "";
  const question = m.question?.toLowerCase() ?? "";
  for (const keyword of EXCLUSION_KEYWORDS) {
    if (slug.includes(keyword) || question.includes(keyword)) return false;
  }
  if (categoryFromSlug(m.slug) === "politics") return true;
  if (m.category?.toLowerCase().includes("politic") || m.category?.toLowerCase().includes("election")) return true;
  if (slug.split("-").some((t) => POLITICAL_PREFIXES.has(t))) return true;
  return ["president", "election", "congress", "senate", "governor", "political", "primary", "nominee"]
    .some((keyword) => question.includes(keyword));
}

function daysToResolution(endDate: string | null): number | null {
  if (!endDate) return null;
  const end = new Date(endDate).getTime();
  if (!Number.isFinite(end)) return null;
  return (end - Date.now()) / 86_400_000;
}

export function calibratedPoliticalProbability(price: number): number {
  const p = Math.min(0.999, Math.max(0.001, price));
  const logit = Math.log(p / (1 - p));
  return 1 / (1 + Math.exp(-POLITICAL_CALIBRATION_SLOPE * logit));
}

export interface ScanResult {
  scanned: number;
  signals: number;
  skipped: number;
  reasons: Map<string, number>;
}

export async function runScanPoliticalFavorites(): Promise<ScanResult> {
  const result: ScanResult = { scanned: 0, signals: 0, skipped: 0, reasons: new Map() };
  const skip = (reason: string) => {
    result.skipped++;
    result.reasons.set(reason, (result.reasons.get(reason) ?? 0) + 1);
  };

  let allMarkets: GammaMarket[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await getActiveMarkets({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      liquidityMin: MIN_LIQUIDITY,
    });
    allMarkets = allMarkets.concat(batch);
    if (batch.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const markets = allMarkets.filter(isPoliticalMarket);
  console.log(`scanPoliticalFavorites: ${allMarkets.length} total markets, ${markets.length} political`);

  for (const m of markets) {
    result.scanned++;
    if (!m.acceptingOrders || m.closed) { skip("not-tradeable"); continue; }
    if (m.outcomes.length !== 2 || m.clobTokenIds.length !== 2) { skip("non-binary"); continue; }
    if (m.liquidity < MIN_LIQUIDITY || m.liquidity > MAX_LIQUIDITY) { skip("liquidity-out-of-range"); continue; }
    if (m.liquidity > 0 && m.volume24hr / m.liquidity > MAX_TOXIC_RATIO) { skip("toxic-flow"); continue; }

    const dtr = daysToResolution(m.endDate);
    if (dtr == null) { skip("missing-end-date"); continue; }
    if (dtr < MIN_DAYS_TO_RESOLUTION || dtr > MAX_DAYS_TO_RESOLUTION) { skip("bad-resolution-time"); continue; }

    const yesPrice = m.outcomePrices[0] ?? 0;
    const noPrice = m.outcomePrices[1] ?? 0;
    let outcomeIndex = -1;
    if (yesPrice >= MIN_FAVORITE_PRICE && yesPrice <= MAX_FAVORITE_PRICE) outcomeIndex = 0;
    else if (noPrice >= MIN_FAVORITE_PRICE && noPrice <= MAX_FAVORITE_PRICE) outcomeIndex = 1;
    else { skip("price-out-of-range"); continue; }

    const outcome = m.outcomes[outcomeIndex] ?? (outcomeIndex === 0 ? "Yes" : "No");
    const tokenId = m.clobTokenIds[outcomeIndex];
    if (!tokenId) { skip("missing-token"); continue; }

    const existing = await prisma.paperTrade.findFirst({
      where: { marketId: m.id, outcome, status: "open", source: "strategy" },
    });
    if (existing) { skip("duplicate"); continue; }

    let book: OrderBook;
    let feeModel: FeeModel;
    try {
      [book, feeModel] = await Promise.all([
        getOrderBook(tokenId),
        getFeeModel(tokenId, m.conditionId ?? m.id),
      ]);
    } catch {
      skip("quote-failed");
      continue;
    }

    const buy = quoteBuyWithCash(book, feeModel, POSITION_SIZE);
    if (!buy) { skip("insufficient-depth"); continue; }
    if (buy.spread == null || buy.spread > MAX_SPREAD) { skip("wide-spread"); continue; }
    if (buy.averageAsk < MIN_FAVORITE_PRICE || buy.averageAsk > MAX_FAVORITE_PRICE) { skip("ask-out-of-range"); continue; }

    const marketMid = buy.bestBid != null ? (buy.bestBid + buy.bestAsk) / 2 : m.outcomePrices[outcomeIndex];
    const probability = calibratedPoliticalProbability(marketMid);
    const edgeEstimate = probability - buy.allInPrice;
    if (edgeEstimate < MIN_NET_EDGE) { skip("net-edge-too-small"); continue; }

    const mark = quoteSellSharesExact(book, feeModel, buy.shares)?.netPrice ?? buy.bestBid ?? buy.averageAsk;
    const reasons = [
      `electoral favorite: ${outcome}`,
      `executable ask=${buy.averageAsk.toFixed(4)} all-in=${buy.allInPrice.toFixed(4)} fee=$${buy.fee.toFixed(4)}`,
      `calibrated p=${probability.toFixed(4)} net edge=${edgeEstimate.toFixed(4)}`,
      `liq=$${m.liquidity.toFixed(0)} spread=${(buy.spread * 100).toFixed(2)}% dtr=${dtr.toFixed(1)}d`,
    ];

    const signal = await prisma.strategySignal.create({
      data: {
        strategy: STRATEGY_NAME,
        marketId: m.id,
        slug: m.slug,
        question: m.question,
        category: "politics",
        outcome,
        side: "BUY",
        entryPrice: buy.allInPrice,
        favoritePrice: marketMid,
        liquidity: m.liquidity,
        spread: buy.spread,
        volume: m.volume24hr,
        daysToResolution: dtr,
        edgeEstimate,
        reasonsJson: JSON.stringify(reasons),
        status: "paper_copy",
      },
    });

    const pt = await prisma.paperTrade.create({
      data: {
        walletAddress: `STRATEGY:${STRATEGY_NAME}`,
        marketId: m.id,
        slug: m.slug,
        tokenId,
        outcome,
        side: "BUY",
        entryPrice: buy.allInPrice,
        currentPrice: mark,
        simulatedPositionSize: buy.cashCost,
        unrealizedPnl: buy.shares * (mark - buy.allInPrice),
        status: "open",
        source: "strategy",
        strategySignalId: signal.id,
      },
    });
    await prisma.strategySignal.update({ where: { id: signal.id }, data: { paperTradeId: pt.id } });
    // ponytail: live execution path for political favorites, see tryPoliticalLiveOrder
    try {
      await tryPoliticalLiveOrder({
        paperTradeId: pt.id,
        buy,
        tokenId,
        marketId: m.id,
        slug: m.slug,
        outcome,
        reasons,
        realTradingEnabled,
      });
    } catch (err) {
      console.warn("Political live order failed (paper preserved): " + (err instanceof Error ? err.message : String(err)));
    }

    result.signals++;
    console.log(`  ✓ ${m.question?.slice(0, 60)} → BUY ${outcome} all-in ${buy.allInPrice.toFixed(4)} edge ${edgeEstimate.toFixed(4)}`);
  }

  console.log(`scanPoliticalFavorites done: ${result.scanned} scanned, ${result.signals} signals, ${result.skipped} skipped`);
  if (result.reasons.size) console.log("  skip reasons:", Object.fromEntries(result.reasons));
  return result;
}


export interface PoliticalLiveOrderParams {
  paperTradeId: string;
  buy: { cashCost: number; allInPrice: number; shares: number; fee: number; spread: number | null; averageAsk: number; bestBid: number | null; bestAsk: number };
  tokenId: string;
  marketId: string;
  slug: string | null;
  outcome: string;
  reasons: string[];
}

export async function tryPoliticalLiveOrder(params: PoliticalLiveOrderParams & { realTradingEnabled: boolean }): Promise<{ decisionJournalId: string } | null> {
  if (!params.realTradingEnabled) return null;
  const dj = await prisma.decisionJournal.create({
    data: {
      observedTradeId: null,
      walletAddress: "STRATEGY:political_favorites",
      marketId: params.marketId,
      decision: "paper_copy",
      executableAsk: params.buy.averageAsk,
      allInPrice: params.buy.allInPrice,
      fee: params.buy.fee,
      spread: params.buy.spread ?? 0,
      shares: params.buy.shares,
      reasonsJson: JSON.stringify(params.reasons),
    },
  });
  await prisma.paperTrade.update({
    where: { id: params.paperTradeId },
    data: { decisionJournalId: dj.id },
  });
  const { executeWalletCopyOrder } = await import("../lib/liveExecution.js");
  try {
    await executeWalletCopyOrder({
      tokenId: params.tokenId,
      cashBudget: params.buy.cashCost,
      allInPrice: params.buy.allInPrice,
      shares: params.buy.shares,
      decisionJournalId: dj.id,
      walletAddress: "STRATEGY:political_favorites",
      marketId: params.marketId,
      slug: params.slug,
    });
  } catch (err) {
    console.warn("Political live order failed (paper preserved): " + (err instanceof Error ? err.message : String(err)));
  }
  return { decisionJournalId: dj.id };
}


if (require.main === module) runScanPoliticalFavorites().catch(console.error);
