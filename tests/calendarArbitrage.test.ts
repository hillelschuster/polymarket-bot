import { describe, expect, it } from "vitest";
import { findCalendarPairs, normalizeCalendarQuestion, outcomeToken } from "../src/lib/calendarArbitrage.js";
import { quoteBuyShares, type GammaMarket, type OrderBook } from "../src/adapters/polymarket.js";

function market(id: string, question: string, endDate: string): GammaMarket {
  return {
    id,
    conditionId: `condition-${id}`,
    question,
    slug: `slug-${id}`,
    category: "politics",
    description: "Resolves Yes if the event happens by the stated deadline.",
    resolutionSource: "https://official.example/source",
    eventId: "event-1",
    eventSlug: "event-1",
    outcomes: ["Yes", "No"],
    outcomePrices: [0.5, 0.5],
    clobTokenIds: [`yes-${id}`, `no-${id}`],
    liquidity: 20_000,
    spread: 0.01,
    volume24hr: 1_000,
    volume: 10_000,
    endDate,
    acceptingOrders: true,
    active: true,
    closed: false,
  };
}

describe("calendar pair detection", () => {
  it("pairs identical questions differing only by deadline", () => {
    const early = market("early", "Will X happen by July 25, 2026?", "2026-07-25T23:59:00Z");
    const late = market("late", "Will X happen by July 31, 2026?", "2026-07-31T23:59:00Z");
    const pairs = findCalendarPairs([early, late], Date.parse("2026-07-21T00:00:00Z"));
    expect(pairs).toHaveLength(1);
    expect(outcomeToken(early, "No")).toBe("no-early");
    expect(outcomeToken(late, "Yes")).toBe("yes-late");
  });

  it("does not treat year-specific 'in 2026' markets as monotonic deadlines", () => {
    expect(normalizeCalendarQuestion("Will X happen in 2026?")).not.toContain("<deadline>");
  });

  it("rejects differing resolution sources", () => {
    const early = market("early", "Will X happen by July 25, 2026?", "2026-07-25T23:59:00Z");
    const late = market("late", "Will X happen by July 31, 2026?", "2026-07-31T23:59:00Z");
    late.resolutionSource = "https://different.example/source";
    expect(findCalendarPairs([early, late], Date.parse("2026-07-21T00:00:00Z"))).toHaveLength(0);
  });
});

describe("executable basket cost", () => {
  const book: OrderBook = {
    market: "condition",
    asset_id: "token",
    bids: [{ price: "0.47", size: "100" }],
    asks: [{ price: "0.48", size: "100" }],
    min_order_size: "1",
  };

  it("uses ask depth and taker fees", () => {
    const quote = quoteBuyShares(book, 400, 10);
    expect(quote).not.toBeNull();
    expect(quote!.averageAsk).toBeCloseTo(0.48);
    expect(quote!.allInPrice).toBeGreaterThan(0.48);
    expect(quote!.spread).toBeCloseTo(0.01);
  });

  it("rejects insufficient depth", () => {
    expect(quoteBuyShares(book, 0, 101)).toBeNull();
  });
});
