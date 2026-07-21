import { describe, expect, it } from "vitest";
import type { GammaMarket, OrderBook } from "../src/adapters/polymarket.js";
import { findCalendarPairs } from "../src/lib/calendarArbitrage.js";
import { quoteCalendarBasket } from "../src/lib/calendarExecution.js";
import { takerFeePerShare } from "../src/lib/executableQuotes.js";
import { applyMarketMessage, RealtimeOrderBook, worstAskForShares, worstBidForShares } from "../src/lib/realtimeOrderBook.js";

function book(asset: string, bids: Array<[number, number]>, asks: Array<[number, number]>): OrderBook {
  return {
    market: "0xmarket",
    asset_id: asset,
    bids: bids.map(([price, size]) => ({ price: String(price), size: String(size) })),
    asks: asks.map(([price, size]) => ({ price: String(price), size: String(size) })),
    min_order_size: "1",
    tick_size: "0.01",
    neg_risk: false,
  };
}

function market(id: string, question: string, endDate: string, eventId: string): GammaMarket {
  return {
    id,
    conditionId: `0x${id.padStart(64, "0")}`,
    question,
    slug: `market-${id}`,
    category: null,
    description: question.replace("Will", "This market resolves Yes if") + ".",
    resolutionSource: "Official source",
    eventId,
    eventSlug: null,
    outcomes: ["Yes", "No"],
    outcomePrices: [0.5, 0.5],
    clobTokenIds: [`${id}yes`, `${id}no`],
    liquidity: 20_000,
    spread: 0.01,
    volume24hr: 0,
    volume: 0,
    endDate,
    acceptingOrders: true,
    active: true,
    closed: false,
  };
}

describe("calendar pair discovery", () => {
  it("pairs identical terms across different event IDs", () => {
    const early = market("1", "Will X happen by July 25, 2027?", "2027-07-25T23:59:00Z", "event-a");
    const late = market("2", "Will X happen by July 31, 2027?", "2027-07-31T23:59:00Z", "event-b");
    expect(findCalendarPairs([early, late], Date.parse("2027-07-20T00:00:00Z"))).toHaveLength(1);
  });
});

describe("RealtimeOrderBook", () => {
  it("applies snapshots, updates, and removals", () => {
    const books = new Map<string, RealtimeOrderBook>();
    applyMarketMessage(books, {
      event_type: "book",
      asset_id: "A",
      market: "M",
      bids: [{ price: "0.39", size: "20" }],
      asks: [{ price: "0.40", size: "10" }, { price: "0.41", size: "20" }],
    });
    applyMarketMessage(books, {
      event_type: "price_change",
      market: "M",
      price_changes: [
        { asset_id: "A", side: "SELL", price: "0.40", size: "0" },
        { asset_id: "A", side: "SELL", price: "0.405", size: "15" },
      ],
    });
    const live = books.get("A")!.toOrderBook();
    expect(live.asks[0]).toEqual({ price: "0.405", size: "15" });
    expect(worstAskForShares(live, 12)).toBe(0.405);
    expect(worstBidForShares(live, 10)).toBe(0.39);
  });
});

describe("fee-aware executable basket", () => {
  it("uses the market fee exponent", () => {
    expect(takerFeePerShare(0.5, { rateBps: 2500, exponent: 2 })).toBeCloseTo(0.015625, 8);
  });

  it("quotes equal shares and guaranteed terminal profit", () => {
    const quote = quoteCalendarBasket({
      earlyBook: book("early", [[0.39, 100]], [[0.40, 100]]),
      lateBook: book("late", [[0.54, 100]], [[0.55, 100]]),
      earlyFee: { rateBps: 0, exponent: 0 },
      lateFee: { rateBps: 0, exponent: 0 },
      basketCash: 10,
      maxCombinedCost: 0.975,
      maxLegSpread: 0.02,
      minProfit: 0.1,
    });
    expect(quote).not.toBeNull();
    expect(quote!.combinedCost).toBeCloseTo(0.95, 8);
    expect(quote!.guaranteedProfit).toBeCloseTo(quote!.shares * 0.05, 8);
  });

  it("rejects inadequate depth", () => {
    expect(quoteCalendarBasket({
      earlyBook: book("early", [[0.39, 100]], [[0.40, 1]]),
      lateBook: book("late", [[0.54, 100]], [[0.55, 100]]),
      earlyFee: { rateBps: 0, exponent: 0 },
      lateFee: { rateBps: 0, exponent: 0 },
      basketCash: 10,
      maxCombinedCost: 0.975,
      maxLegSpread: 0.02,
      minProfit: 0.1,
    })).toBeNull();
  });
});
