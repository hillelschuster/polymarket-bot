// Tests: benchmark comparison produces sensible metrics. SPEC §15.
import { describe, it, expect } from "vitest";
import { compareStrategies } from "../src/lib/benchmark.js";

describe("compareStrategies", () => {
  const trades = [
    { id: "1", strategy: "bot" as const, pnl: 20, marketId: "m1", walletAddress: "0xa" },
    { id: "2", strategy: "bot" as const, pnl: -5, marketId: "m2", walletAddress: "0xa" },
    { id: "3", strategy: "blind" as const, pnl: 10, marketId: "m3", walletAddress: "0xb" },
    { id: "4", strategy: "blind" as const, pnl: -15, marketId: "m4", walletAddress: "0xc" },
    { id: "5", strategy: "watchlist" as const, pnl: 3, marketId: "m5", walletAddress: "0xd" },
    { id: "6", strategy: "skipped" as const, pnl: -5, marketId: "m6", walletAddress: "0xe" },
    { id: "7", strategy: "skipped" as const, pnl: 12, marketId: "m7", walletAddress: "0xf" },
  ];

  const result = compareStrategies(trades);

  it("counts trades per strategy", () => {
    expect(result.botFiltered.count).toBe(2);
    expect(result.blindCopy.count).toBe(2);
    expect(result.watchlist.count).toBe(1);
    expect(result.skipped.count).toBe(2);
  });

  it("computes net PnL per strategy", () => {
    expect(result.botFiltered.netPnl).toBe(15);  // 20 + (-5)
    expect(result.blindCopy.netPnl).toBe(-5);    // 10 + (-15)
    expect(result.skipped.netPnl).toBe(7);       // (-5) + 12
  });

  it("computes avg PnL per strategy", () => {
    expect(result.botFiltered.avgPnl).toBe(7.5);  // 15/2
    expect(result.skipped.avgPnl).toBe(3.5);      // 7/2
  });

  it("identifies missed winners (skipped or blind trades with pnl > 0)", () => {
    expect(result.missedWinners).toHaveLength(2);
    expect(result.missedWinners.map(t => t.id)).toContain("7"); // skipped +12
    expect(result.missedWinners.map(t => t.id)).toContain("3"); // blind +10
  });

  it("identifies avoided losers (skipped trades with pnl < 0 — good)", () => {
    expect(result.avoidedLosers).toHaveLength(1);
    expect(result.avoidedLosers[0].id).toBe("6");
  });

  it("identifies bad copies (bot/blind with pnl < 0)", () => {
    expect(result.badCopies).toHaveLength(2);
    expect(result.badCopies.map(t => t.id)).toContain("2");
    expect(result.badCopies.map(t => t.id)).toContain("4");
  });

  it("identifies good skips (skipped trades that lost)", () => {
    expect(result.goodSkips).toHaveLength(1);
    expect(result.goodSkips[0].id).toBe("6");
  });

  it("handles empty input", () => {
    const empty = compareStrategies([]);
    expect(empty.botFiltered.count).toBe(0);
    expect(empty.botFiltered.netPnl).toBe(0);
    expect(empty.missedWinners).toHaveLength(0);
    expect(empty.avoidedLosers).toHaveLength(0);
  });
});
