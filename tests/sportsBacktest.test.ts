import { describe, expect, it } from "vitest";
import {
  favoriteAtEntry,
  normalizeFeeRate,
  simulateTakerBuy,
  summarizeBacktest,
  type BacktestRow,
  type HistoricalTrade,
} from "../src/lib/sportsBacktest.js";

const trade = (asset: string, side: string, price: number, size: number, timestamp: number): HistoricalTrade => ({
  asset,
  side,
  price,
  size,
  timestamp,
});

describe("sports historical entry", () => {
  it("chooses the favorite using only pre-entry trades", () => {
    const trades = [
      trade("A", "BUY", 0.68, 10, 900),
      trade("B", "BUY", 0.32, 10, 910),
      trade("B", "BUY", 0.90, 10, 1_010), // future information must not leak
    ];
    const favorite = favoriteAtEntry(trades, ["A", "B"], 1_000, 300);
    expect(favorite?.tokenId).toBe("A");
    expect(favorite?.referencePrice).toBeCloseTo(0.68);
  });

  it("infers the opposite token and rejects stale references", () => {
    const fresh = favoriteAtEntry([trade("B", "BUY", 0.29, 10, 950)], ["A", "B"], 1_000, 300);
    expect(fresh?.tokenId).toBe("A");
    expect(fresh?.referencePrice).toBeCloseTo(0.71);
    expect(favoriteAtEntry([trade("A", "BUY", 0.70, 10, 100)], ["A", "B"], 1_000, 300)).toBeNull();
  });

  it("simulates a conservative taker fill with one tick slippage and fees", () => {
    const trades = [
      trade("A", "SELL", 0.69, 100, 1_001), // cannot fill our buy
      trade("A", "BUY", 0.70, 10, 1_002),
      trade("A", "BUY", 0.71, 100, 1_004),
    ];
    const fill = simulateTakerBuy(trades, "A", 1_000, 10, 20, 0.03, 0.01);
    expect(fill).not.toBeNull();
    expect(fill!.fillRatio).toBeGreaterThan(0.99);
    expect(fill!.averagePrice).toBeGreaterThanOrEqual(0.71);
    expect(fill!.allInPrice).toBeGreaterThan(fill!.averagePrice);
    expect(fill!.tradeCount).toBe(2);
  });

  it("does not use prints outside the fill window", () => {
    const trades = [trade("A", "BUY", 0.70, 100, 1_100)];
    expect(simulateTakerBuy(trades, "A", 1_000, 30, 20, 0.03, 0.01)).toBeNull();
  });
});

describe("sports backtest accounting", () => {
  it("normalizes decimal and basis-point fee fields", () => {
    expect(normalizeFeeRate(0.03)).toBeCloseTo(0.03);
    expect(normalizeFeeRate(30)).toBeCloseTo(0.003);
    expect(normalizeFeeRate(undefined)).toBeCloseTo(0.03);
  });

  it("summarizes realized returns and same-day clustering", () => {
    const base: Omit<BacktestRow, "won" | "pnl" | "roi"> = {
      sport: "mlb",
      marketId: "1",
      conditionId: "c",
      slug: "mlb-a-b-2026-07-01",
      gameId: "g",
      eventStartTime: "2026-07-01T20:00:00Z",
      favoriteOutcome: "A",
      favoriteTokenId: "A",
      referencePrice: 0.70,
      averageFillPrice: 0.71,
      allInPrice: 0.715,
      feePaid: 0.1,
      shares: 28,
      cashSpent: 20,
      fillRatio: 1,
      fillSeconds: 2,
    };
    const rows: BacktestRow[] = [
      { ...base, won: true, pnl: 8, roi: 0.4 },
      { ...base, marketId: "2", won: false, pnl: -20, roi: -1 },
    ];
    const summary = summarizeBacktest(rows);
    expect(summary.n).toBe(2);
    expect(summary.independentDays).toBe(1);
    expect(summary.wins).toBe(1);
    expect(summary.cashSpent).toBe(40);
    expect(summary.pnl).toBe(-12);
    expect(summary.roi).toBeCloseTo(-0.3);
  });
});
