// Calendar monotonicity arbitrage: buy early-deadline NO + later-deadline YES.
// Equal shares guarantee at least $1 payout when resolution terms are identical.
import { prisma } from "../lib/db.js";
import type { Prisma } from "@prisma/client";
import {
  getActiveMarkets,
  getFeeRateBps,
  getOrderBook,
  quoteBuyShares,
  quoteSellShares,
  type GammaMarket,
  type OrderBook,
} from "../adapters/polymarket.js";
import { findCalendarPairs, outcomeToken } from "../lib/calendarArbitrage.js";

const STRATEGY_NAME = "calendar_arb";
const BASKET_CASH = 10;
const MAX_COMBINED_COST = 0.975;
const MAX_LEG_SPREAD = 0.02;
const MIN_LIQUIDITY = 5_000;
const MAX_LATE_DAYS = 14;
const MIN_EARLY_HOURS = 6;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

export interface CalendarScanResult {
  markets: number;
  pairs: number;
  signals: number;
  skipped: number;
  reasons: Map<string, number>;
}

function daysUntil(endDate: string): number {
  return (new Date(endDate).getTime() - Date.now()) / 86_400_000;
}

function pairAddress(early: GammaMarket, late: GammaMarket): string {
  return `STRATEGY:${STRATEGY_NAME}:${early.id}:${late.id}`;
}

export async function runScanCalendarArbitrage(): Promise<CalendarScanResult> {
  const result: CalendarScanResult = { markets: 0, pairs: 0, signals: 0, skipped: 0, reasons: new Map() };
  const skip = (reason: string) => {
    result.skipped++;
    result.reasons.set(reason, (result.reasons.get(reason) ?? 0) + 1);
  };

  let markets: GammaMarket[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await getActiveMarkets({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      liquidityMin: MIN_LIQUIDITY,
    });
    markets = markets.concat(batch);
    if (batch.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  result.markets = markets.length;

  const pairs = findCalendarPairs(markets);
  result.pairs = pairs.length;

  for (const { early, late } of pairs) {
    if (!early.endDate || !late.endDate) { skip("missing-end-date"); continue; }
    const earlyDays = daysUntil(early.endDate);
    const lateDays = daysUntil(late.endDate);
    if (earlyDays < MIN_EARLY_HOURS / 24 || lateDays > MAX_LATE_DAYS) { skip("resolution-window"); continue; }
    if (early.liquidity < MIN_LIQUIDITY || late.liquidity < MIN_LIQUIDITY) { skip("low-liquidity"); continue; }

    const earlyNoToken = outcomeToken(early, "No");
    const lateYesToken = outcomeToken(late, "Yes");
    if (!earlyNoToken || !lateYesToken) { skip("missing-token"); continue; }

    const address = pairAddress(early, late);
    const existing = await prisma.paperTrade.findFirst({ where: { walletAddress: address, status: "open" } });
    if (existing) { skip("duplicate"); continue; }

    let earlyBook: OrderBook;
    let lateBook: OrderBook;
    let earlyFeeBps: number;
    let lateFeeBps: number;
    try {
      [earlyBook, lateBook, earlyFeeBps, lateFeeBps] = await Promise.all([
        getOrderBook(earlyNoToken),
        getOrderBook(lateYesToken),
        getFeeRateBps(earlyNoToken),
        getFeeRateBps(lateYesToken),
      ]);
    } catch {
      skip("quote-failed");
      continue;
    }

    const earlyProbeShares = Math.max(1, Number(earlyBook.min_order_size ?? 1));
    const lateProbeShares = Math.max(1, Number(lateBook.min_order_size ?? 1));
    const earlyTop = quoteBuyShares(earlyBook, earlyFeeBps, earlyProbeShares);
    const lateTop = quoteBuyShares(lateBook, lateFeeBps, lateProbeShares);
    if (!earlyTop || !lateTop) { skip("empty-book"); continue; }
    const topCombined = earlyTop.allInPrice + lateTop.allInPrice;
    if (topCombined <= 0 || topCombined > MAX_COMBINED_COST) { skip("cost-too-high"); continue; }

    const shares = BASKET_CASH / topCombined;
    const earlyBuy = quoteBuyShares(earlyBook, earlyFeeBps, shares);
    const lateBuy = quoteBuyShares(lateBook, lateFeeBps, shares);
    if (!earlyBuy || !lateBuy) { skip("insufficient-depth"); continue; }
    if (earlyBuy.spread == null || lateBuy.spread == null || earlyBuy.spread > MAX_LEG_SPREAD || lateBuy.spread > MAX_LEG_SPREAD) {
      skip("wide-spread");
      continue;
    }

    const combinedCost = earlyBuy.allInPrice + lateBuy.allInPrice;
    if (combinedCost > MAX_COMBINED_COST) { skip("cost-too-high-after-depth"); continue; }

    const earlyMark = quoteSellShares(earlyBook, earlyFeeBps, shares)?.netPrice ?? earlyBuy.bestBid ?? earlyBuy.averageAsk;
    const lateMark = quoteSellShares(lateBook, lateFeeBps, shares)?.netPrice ?? lateBuy.bestBid ?? lateBuy.averageAsk;
    const edge = 1 - combinedCost;
    const reasons = JSON.stringify([
      `calendar arb: early NO + late YES`,
      `combined all-in=${combinedCost.toFixed(4)} guaranteed edge=${edge.toFixed(4)}/share`,
      `equal shares=${shares.toFixed(4)} basket cash=$${(earlyBuy.cashCost + lateBuy.cashCost).toFixed(2)}`,
      `early=${early.question} (${early.endDate})`,
      `late=${late.question} (${late.endDate})`,
    ]);

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const earlySignal = await tx.strategySignal.create({
        data: {
          strategy: STRATEGY_NAME,
          marketId: early.id,
          slug: early.slug,
          question: early.question,
          category: early.category,
          outcome: "No",
          side: "BUY",
          entryPrice: earlyBuy.allInPrice,
          favoritePrice: earlyBuy.averageAsk,
          liquidity: early.liquidity,
          spread: earlyBuy.spread,
          volume: early.volume24hr,
          daysToResolution: earlyDays,
          edgeEstimate: edge,
          reasonsJson: reasons,
          status: "paper_copy",
        },
      });
      const earlyTrade = await tx.paperTrade.create({
        data: {
          walletAddress: address,
          marketId: early.id,
          slug: early.slug,
          tokenId: earlyNoToken,
          outcome: "No",
          side: "BUY",
          entryPrice: earlyBuy.allInPrice,
          currentPrice: earlyMark,
          simulatedPositionSize: earlyBuy.cashCost,
          unrealizedPnl: shares * (earlyMark - earlyBuy.allInPrice),
          status: "open",
          source: "strategy",
          strategySignalId: earlySignal.id,
        },
      });
      await tx.strategySignal.update({ where: { id: earlySignal.id }, data: { paperTradeId: earlyTrade.id } });

      const lateSignal = await tx.strategySignal.create({
        data: {
          strategy: STRATEGY_NAME,
          marketId: late.id,
          slug: late.slug,
          question: late.question,
          category: late.category,
          outcome: "Yes",
          side: "BUY",
          entryPrice: lateBuy.allInPrice,
          favoritePrice: lateBuy.averageAsk,
          liquidity: late.liquidity,
          spread: lateBuy.spread,
          volume: late.volume24hr,
          daysToResolution: lateDays,
          edgeEstimate: edge,
          reasonsJson: reasons,
          status: "paper_copy",
        },
      });
      const lateTrade = await tx.paperTrade.create({
        data: {
          walletAddress: address,
          marketId: late.id,
          slug: late.slug,
          tokenId: lateYesToken,
          outcome: "Yes",
          side: "BUY",
          entryPrice: lateBuy.allInPrice,
          currentPrice: lateMark,
          simulatedPositionSize: lateBuy.cashCost,
          unrealizedPnl: shares * (lateMark - lateBuy.allInPrice),
          status: "open",
          source: "strategy",
          strategySignalId: lateSignal.id,
        },
      });
      await tx.strategySignal.update({ where: { id: lateSignal.id }, data: { paperTradeId: lateTrade.id } });
    });

    result.signals++;
    console.log(`  ✓ calendar arb ${combinedCost.toFixed(4)} → ${early.slug} NO + ${late.slug} YES`);
  }

  console.log(`scanCalendarArbitrage done: ${result.markets} markets, ${result.pairs} pairs, ${result.signals} baskets`);
  if (result.reasons.size) console.log("  skip reasons:", Object.fromEntries(result.reasons));
  return result;
}

if (require.main === module) runScanCalendarArbitrage().catch(console.error);
