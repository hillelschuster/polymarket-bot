import { describe, expect, it } from "vitest";
import {
  mainlinePositionSize,
  priorWalletCopyPerformance,
  segmentFromSlug,
} from "../src/lib/scoring.js";
import {
  SCORING_LOOKBACK_MS,
  unscoredObservedTradeWhere,
} from "../src/jobs/scoreTrades.js";
import { trackedWalletWhere } from "../src/jobs/monitorTrades.js";
import { summarizePnl } from "../src/lib/reporting.js";

describe("profitability patch monitoring", () => {
  it("monitors track wallets only", () => {
    expect(trackedWalletWhere()).toEqual({ status: "track" });
  });
});

describe("sports mainline sizing", () => {
  it("sizes a low-score unproven wallet at $5", () => {
    expect(mainlinePositionSize(20, 35, { count: 2, wins: 1, winRate: 0.5, avgPnl: 1 })).toBe(5);
  });

  it("sizes a high-score mainline wallet at $20", () => {
    expect(mainlinePositionSize(35, 35, { count: 0, wins: 0, winRate: 0, avgPnl: 0 })).toBe(20);
  });

  it("sizes a low-score but qualified mainline wallet at $20", () => {
    expect(mainlinePositionSize(20, 35, { count: 3, wins: 2, winRate: 2 / 3, avgPnl: 0.25 })).toBe(20);
  });

  it("qualifies only prior resolved same-segment wallet-copy trades", () => {
    const before = new Date("2026-08-02T12:00:00.000Z");
    const slug = "mlb-yankees-redsox-2026-08-01";
    const trades = [
      { walletAddress: "w", slug, source: "wallet_copy", status: "resolved", realizedPnl: 2, openedAt: new Date("2026-07-31T10:00:00Z"), resolvedAt: new Date("2026-08-01T10:00:00Z") },
      { walletAddress: "w", slug, source: "wallet_copy", status: "resolved", realizedPnl: 1, openedAt: new Date("2026-07-31T11:00:00Z"), resolvedAt: new Date("2026-08-01T11:00:00Z") },
      { walletAddress: "w", slug, source: "wallet_copy", status: "resolved", realizedPnl: -1, openedAt: new Date("2026-07-31T12:00:00Z"), resolvedAt: new Date("2026-08-01T12:00:00Z") },
      { walletAddress: "w", slug, source: "wallet_copy", status: "closed", realizedPnl: 100, openedAt: new Date("2026-07-31T13:00:00Z"), resolvedAt: new Date("2026-08-01T13:00:00Z") },
      { walletAddress: "w", slug, source: "wallet_copy", status: "open", realizedPnl: 100, openedAt: new Date("2026-07-31T14:00:00Z"), resolvedAt: null },
      { walletAddress: "w", slug, source: "wallet_copy", status: "resolved", realizedPnl: 100, openedAt: new Date("2026-08-02T10:00:00Z"), resolvedAt: new Date("2026-08-02T13:00:00Z") },
      { walletAddress: "w", slug, source: "strategy", status: "resolved", realizedPnl: 100, openedAt: new Date("2026-07-31T15:00:00Z"), resolvedAt: new Date("2026-08-01T15:00:00Z") },
    ];

    const performance = priorWalletCopyPerformance(trades, "w", segmentFromSlug(slug), before);
    expect(performance).toEqual({ count: 3, wins: 2, winRate: 2 / 3, avgPnl: 2 / 3 });
    expect(mainlinePositionSize(20, 35, performance)).toBe(20);
  });
});

describe("recent observation scoring", () => {
  it("adds a 24-hour floor without deleting old SQLite rows", () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    const where = unscoredObservedTradeWhere(now);
    const floor = new Date(now.getTime() - SCORING_LOOKBACK_MS);

    expect(where.decision).toBeNull();
    expect(where.timestamp).toEqual({ gte: floor });
    expect(new Date("2026-08-01T11:59:59.999Z") < floor).toBe(true);
    expect(new Date("2026-08-01T12:00:00.000Z") >= floor).toBe(true);
  });
});

describe("reporting populations", () => {
  it("keeps wallet-copy, strategy, legacy closed, and open PnL separate", () => {
    const breakdown = summarizePnl([
      { source: "wallet_copy", status: "resolved", realizedPnl: 100, unrealizedPnl: 0 },
      { source: "strategy", status: "resolved", realizedPnl: 5, unrealizedPnl: 0 },
      { source: "wallet_copy", status: "closed", realizedPnl: -130, unrealizedPnl: 0 },
      { source: "wallet_copy", status: "open", realizedPnl: null, unrealizedPnl: -2 },
      { source: "strategy", status: "open", realizedPnl: null, unrealizedPnl: 3 },
    ]);

    expect(breakdown.resolvedWalletCopyPnl).toBe(100);
    expect(breakdown.resolvedStrategyPnl).toBe(5);
    expect(breakdown.legacyClosedStopLossPnl).toBe(-130);
    expect(breakdown.openWalletCopyUnrealizedPnl).toBe(-2);
    expect(breakdown.openStrategyUnrealizedPnl).toBe(3);
    expect(breakdown.combinedAccountingTotal).toBe(-24);
    expect(breakdown.resolvedWalletCopyWinRate).toBe(1);
  });
});
