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
  // Position size is DOLLARS (cash invested), not shares.
  // shares = cashInvested / entryPrice
  // PnL = shares * (currentPrice - entryPrice)
  //
  // Example: $100 at $0.50 = 200 shares
  // At $0.80: PnL = 200 * (0.80 - 0.50) = $60

  it("BUY side: shares * (current - entry)", () => {
    // $100 at $0.50 = 200 shares; at $0.80: 200 * 0.30 = $60
    expect(unrealizedPnl("BUY", 0.5, 0.8, 100)).toBe(60);
    // At $0.30: 200 * -0.20 = -$40
    expect(unrealizedPnl("BUY", 0.5, 0.3, 100)).toBe(-40);
  });

  it("YES side: same as BUY", () => {
    expect(unrealizedPnl("YES", 0.5, 0.8, 100)).toBe(60);
  });

  it("SELL side: shares * (entry - current)", () => {
    // $100 at $0.50 = 200 shares; at $0.30: 200 * 0.20 = $40
    expect(unrealizedPnl("SELL", 0.5, 0.3, 100)).toBe(40);
    // At $0.80: 200 * -0.30 = -$60
    expect(unrealizedPnl("SELL", 0.5, 0.8, 100)).toBe(-60);
  });

  it("NO side: same as SELL", () => {
    expect(unrealizedPnl("NO", 0.5, 0.3, 100)).toBe(40);
  });

  it("handles zero entry price gracefully", () => {
    expect(unrealizedPnl("BUY", 0, 0.5, 100)).toBe(0);
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
