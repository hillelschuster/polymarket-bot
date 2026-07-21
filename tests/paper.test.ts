// Tests: paper trade creation, PnL math, resolve. SPEC §15.
import { describe, it, expect } from "vitest";
import { createPaperTrade, unrealizedPnl, hourlyPnl, resolvePaperTrade } from "../src/lib/paper.js";

describe("createPaperTrade", () => {
  const signal = { walletAddress: "0xabc", marketId: "m1", outcome: "YES", side: "BUY", entryPrice: 0.5 };

  it("returns size between $5 and $20", () => {
    const t1 = createPaperTrade(signal, 0);
    expect(t1.simulatedPositionSize).toBeGreaterThanOrEqual(5);
    expect(t1.simulatedPositionSize).toBeLessThanOrEqual(20);

    const t2 = createPaperTrade(signal, 1);
    expect(t2.simulatedPositionSize).toBeGreaterThanOrEqual(5);
    expect(t2.simulatedPositionSize).toBeLessThanOrEqual(20);
  });

  it("scales size with confidence", () => {
    const low = createPaperTrade(signal, 0);
    const high = createPaperTrade(signal, 1);
    expect(high.simulatedPositionSize).toBeGreaterThan(low.simulatedPositionSize);
  });

  it("status is open", () => {
    const t = createPaperTrade(signal, 0.5);
    expect(t.status).toBe("open");
  });

  it("unrealizedPnl is 0 at entry", () => {
    const t = createPaperTrade(signal, 0.5);
    expect(t.unrealizedPnl).toBe(0);
  });
});

describe("unrealizedPnl", () => {
  it("BUY side: size * (current - entry)", () => {
    expect(unrealizedPnl("BUY", 0.5, 0.8, 100)).toBe(30);
    expect(unrealizedPnl("BUY", 0.5, 0.3, 100)).toBe(-20);
  });

  it("YES side: same as BUY", () => {
    expect(unrealizedPnl("YES", 0.5, 0.8, 100)).toBe(30);
  });

  it("SELL side: size * (entry - current)", () => {
    expect(unrealizedPnl("SELL", 0.5, 0.3, 100)).toBe(20);
    expect(unrealizedPnl("SELL", 0.5, 0.8, 100)).toBe(-30);
  });

  it("NO side: same as SELL", () => {
    expect(unrealizedPnl("NO", 0.5, 0.3, 100)).toBe(20);
  });
});

describe("hourlyPnl", () => {
  it("updates currentPrice and unrealizedPnl", () => {
    const trade = createPaperTrade(
      { walletAddress: "0xabc", marketId: "m1", outcome: "YES", side: "BUY", entryPrice: 0.5 },
      0.5,
    );
    const updated = hourlyPnl(trade, 0.75);
    expect(updated.currentPrice).toBe(0.75);
    expect(updated.unrealizedPnl).toBeGreaterThan(0);
    expect(updated.status).toBe("open");
  });
});

describe("resolvePaperTrade", () => {
  it("win: final price = 1, realizedPnl = size * (1 - entry)", () => {
    const trade = createPaperTrade(
      { walletAddress: "0xabc", marketId: "m1", outcome: "YES", side: "BUY", entryPrice: 0.4 },
      0.5,
    );
    const resolved = resolvePaperTrade(trade, "win");
    expect(resolved.status).toBe("resolved");
    expect(resolved.currentPrice).toBe(1);
    expect(resolved.realizedPnl).toBeGreaterThan(0);
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it("lose: final price = 0, realizedPnl = size * (0 - entry) = negative", () => {
    const trade = createPaperTrade(
      { walletAddress: "0xabc", marketId: "m1", outcome: "YES", side: "BUY", entryPrice: 0.4 },
      0.5,
    );
    const resolved = resolvePaperTrade(trade, "lose");
    expect(resolved.status).toBe("resolved");
    expect(resolved.currentPrice).toBe(0);
    expect(resolved.realizedPnl).toBeLessThan(0);
  });
});
