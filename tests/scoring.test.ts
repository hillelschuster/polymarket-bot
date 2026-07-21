// Tests: wallet scoring, one-hit-wonder, market equation, trade scoring + decisions. SPEC §15.
import { describe, it, expect } from "vitest";
import {
  scoreWallet,
  scoreTrade,
  scoreTradeByMarket,
  categoryFromSlug,
  walletCopySkipReason,
  DEFAULT_RULES,
  type MarketFeatures,
} from "../src/lib/scoring.js";

describe("scoreWallet", () => {
  const good = {
    roi30d: 0.5,
    winRate30d: 0.7,
    resolvedTradeCount30d: 20,
    tradeCount30d: 30,
    averageLiquidity: 80_000,
    averageSpread: 0.02,
    averageEntryTiming: 10, // entered 10 days before resolution (good timing)
    categoryStrengths: { sports: 0.8, crypto: 0.3 }, // win-rate fraction (0..1)
    tradePnls: [50, 30, 20, 10, -5],
    returnVariance: 0.2,
  };

  it("returns global score between 0 and 100", () => {
    const result = scoreWallet(good);
    expect(result.global).toBeGreaterThanOrEqual(0);
    expect(result.global).toBeLessThanOrEqual(100);
  });

  it("has all 6 components", () => {
    const result = scoreWallet(good);
    expect(result.components).toHaveProperty("roiScore");
    expect(result.components).toHaveProperty("consistency");
    expect(result.components).toHaveProperty("copyability");
    expect(result.components).toHaveProperty("categoryEdge");
    expect(result.components).toHaveProperty("oneHitPenalty");
    expect(result.components).toHaveProperty("illiquidPenalty");
  });

  it("applies one-hit-wonder penalty when top trade dominates", () => {
    const oneHit = {
      ...good,
      tradePnls: [500, 1, -2, 3], // top 500 >> 50% of 506
    };
    const result = scoreWallet(oneHit);
    expect(result.components.oneHitPenalty).toBe(DEFAULT_RULES.ONE_HIT_PENALTY);
  });

  it("no one-hit penalty when PnL is distributed", () => {
    const distributed = {
      ...good,
      tradePnls: [50, 45, 40, 35, 30],
    };
    const result = scoreWallet(distributed);
    expect(result.components.oneHitPenalty).toBe(0);
  });

  it("applies illiquid penalty when liquidity is low", () => {
    const illiquid = { ...good, averageLiquidity: 1000 };
    const result = scoreWallet(illiquid);
    expect(result.components.illiquidPenalty).toBeGreaterThan(0);
  });

  it("applies spread penalty when spread is wide", () => {
    const wide = { ...good, averageSpread: 0.15 };
    const result = scoreWallet(wide);
    expect(result.components.illiquidPenalty).toBeGreaterThan(0);
  });

  it("returns higher score for better wallet", () => {
    const low = { ...good, roi30d: 0.01, winRate30d: 0.3, tradePnls: [1] };
    const high = scoreWallet(good);
    const lowScore = scoreWallet(low);
    expect(high.global).toBeGreaterThan(lowScore.global);
  });

  it("categoryEdge uses max category strength", () => {
    const result = scoreWallet(good);
    expect(result.components.categoryEdge).toBe(80);
  });

  it("uses custom rules when provided", () => {
    const custom = { ...DEFAULT_RULES, W_roi: 0, ONE_HIT_PENALTY: 99 };
    const result = scoreWallet({ ...good, tradePnls: [500, 1] }, custom);
    expect(result.components.oneHitPenalty).toBe(99);
    expect(result.components.roiScore).toBeGreaterThan(0); // still computed
    // but global won't include roiScore since weight == 0
  });
});

describe("categoryFromSlug", () => {
  it("maps known sports/esports/crypto/politics prefixes", () => {
    expect(categoryFromSlug("mlb-lad-nyy-2026-07-18")).toBe("sports");
    expect(categoryFromSlug("dota2-bb4-vg-2026-07-18")).toBe("esports");
    expect(categoryFromSlug("crypto-btc-usd-2026")).toBe("crypto");
    expect(categoryFromSlug("politics-us-2024-election")).toBe("politics");
  });
  it("returns null for unknown/generic prefixes", () => {
    expect(categoryFromSlug("will-x-happen-2026")).toBeNull();
    expect(categoryFromSlug("2026-something")).toBeNull();
    expect(categoryFromSlug(null)).toBeNull();
    expect(categoryFromSlug(undefined)).toBeNull();
  });
});

describe("scoreTradeByMarket (wallet-independent equation)", () => {
  const base: MarketFeatures = {
    side: "BUY",
    currentPrice: 0.5,
    priceMovementSinceEntry: 0.05,
    spread: 0.02,
    liquidity: 100_000,
    volume: 0,
    daysToResolution: 10,
  };

  it("scores a liquid, tight, favorable, favorite market highly", () => {
    const f: MarketFeatures = {
      side: "BUY", currentPrice: 0.8, priceMovementSinceEntry: 0.1,
      spread: 0.01, liquidity: 100_000, volume: 0, daysToResolution: 30,
    };
    const r = scoreTradeByMarket(f);
    expect(r.skip).toBe(false);
    expect(r.score).toBeGreaterThan(70);
  });

  it("skips BUY at a top (price > topThreshold)", () => {
    expect(scoreTradeByMarket({ ...base, currentPrice: 0.9 }).skip).toBe(true);
  });

  it("skips SELL at a bottom (price < 1-topThreshold)", () => {
    expect(scoreTradeByMarket({ ...base, side: "SELL", currentPrice: 0.1 }).skip).toBe(true);
  });

  it("skips when price moved against the bet (adverse move)", () => {
    expect(scoreTradeByMarket({ ...base, side: "SELL", priceMovementSinceEntry: 0.1 }).skip).toBe(true);
  });

  it("skips markets resolving too soon", () => {
    expect(scoreTradeByMarket({ ...base, daysToResolution: 1 }).skip).toBe(true);
  });

  it("skips toxic flow (volume/liquidity spike)", () => {
    expect(scoreTradeByMarket({ ...base, liquidity: 1000, volume: 100_000 }).skip).toBe(true);
  });

  it("rewards betting the favorite (favorite-longshot bias)", () => {
    const fav = scoreTradeByMarket({ ...base, side: "BUY", currentPrice: 0.8 }).score;
    const long = scoreTradeByMarket({ ...base, side: "BUY", currentPrice: 0.2 }).score;
    expect(fav).toBeGreaterThan(long);
  });
});

describe("scoreTrade", () => {
  const trade = {
    walletGlobalScore: 75,
    priceMovementSinceEntry: 0.05,
    spread: 0.02,
    liquidity: 50_000,
    volume: 0,
    timeToResolution: 5,
  };

  it("returns a valid decision for an eligible trade", () => {
    const result = scoreTrade(trade);
    expect(["paper_copy", "skip"]).toContain(result.decision);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.reasons).toBeInstanceOf(Array);
  });

  it("returns paper_copy for a high-score eligible trade", () => {
    const excellent = {
      ...trade,
      side: "BUY", currentPrice: 0.65, priceMovementSinceEntry: 0.04,
      spread: 0.005, liquidity: 150_000, volume: 0, timeToResolution: 30,
    };
    expect(scoreTrade(excellent, { ...DEFAULT_RULES, minFavoritePrice: 0 }).decision).toBe("paper_copy");
  });

  it("returns skip when price moved against the bet (adverse move)", () => {
    const bad = {
      ...trade, side: "BUY", currentPrice: 0.5, priceMovementSinceEntry: -0.1,
      spread: 0.01, liquidity: 100_000,
    };
    expect(scoreTrade(bad).decision).toBe("skip");
  });

  it("returns skip when entry gap exceeds maxEntryGap", () => {
    const mid = {
      ...trade, side: "BUY", currentPrice: 0.8, priceMovementSinceEntry: 0.1,
      spread: 0.01, liquidity: 100_000, // entryGap = 0.1 > 0.05
    };
    expect(scoreTrade(mid).decision).toBe("skip");
  });

  it("is direction-aware: top-avoidance blocks BUY but not SELL", () => {
    // BUY at 0.9 -> skip (top-avoidance). SELL at 0.9 -> paper_copy (minFavoritePrice: 0 bypasses gate).
    const rules = { ...DEFAULT_RULES, minFavoritePrice: 0, minMarketLiquidity: 0, maxMarketLiquidity: 0 };
    const buy = { ...trade, side: "BUY", currentPrice: 0.9, priceMovementSinceEntry: 0.05 };
    const sell = { ...trade, side: "SELL", currentPrice: 0.9, priceMovementSinceEntry: 0.05 };
    expect(scoreTrade(buy, rules).decision).toBe("skip");
    expect(scoreTrade(sell, rules).decision).toBe("paper_copy");
  });

  it("avoids tops: BUY when price > topThreshold -> skip", () => {
    const top = { ...trade, currentPrice: 0.9, side: "BUY" };
    expect(scoreTrade(top).decision).toBe("skip");
  });

  it("avoids tops: SELL when price < 1-topThreshold -> skip", () => {
    const top = { ...trade, currentPrice: 0.1, side: "SELL" };
    expect(scoreTrade(top).decision).toBe("skip");
  });

  it("top-avoidance applies regardless of wallet global score", () => {
    const top = { ...trade, currentPrice: 0.9, side: "BUY", walletGlobalScore: 95 };
    expect(scoreTrade(top).decision).toBe("skip");
  });

  it("wallet global score does NOT gate decisions (good market features copy even from low-global wallet)", () => {
    const good = {
      ...trade, side: "BUY", currentPrice: 0.65, priceMovementSinceEntry: 0.04,
      spread: 0.005, liquidity: 150_000, volume: 0, timeToResolution: 30, walletGlobalScore: 5,
    };
    expect(scoreTrade(good, { ...DEFAULT_RULES, minFavoritePrice: 0 }).decision).toBe("paper_copy");
  });

  it("does not avoid top when price is mid-range", () => {
    const mid = { ...trade, currentPrice: 0.65, side: "BUY" };
    expect(scoreTrade(mid, { ...DEFAULT_RULES, minFavoritePrice: 0, minMarketLiquidity: 0, maxMarketLiquidity: 0 }).decision).not.toBe("skip");
  });

  it("respects custom thresholds", () => {
    const lowBar = {
      ...DEFAULT_RULES,
      minLiquidity: 0,
      maxSpread: 1,
      minFavoritePrice: 0,
      minMarketLiquidity: 0,
      maxMarketLiquidity: 0,
    };
    const result = scoreTrade(trade, lowBar);
    expect(result.decision).toBe("paper_copy");
  });
});

describe("walletCopySkipReason (copy-performance filter)", () => {
  const base = { side: "BUY", count: 0, avgPnl: 0, winRate: 0, totalPnl: 0, openCount: 0 };

  it("copies a fresh, unproven wallet (exploration)", () => {
    expect(walletCopySkipReason({ ...base })).toBeNull();
  });

  it("drops a (wallet, side) that loses on average once enough samples", () => {
    const r = walletCopySkipReason({ ...base, side: "BUY", count: 5, avgPnl: -0.4 });
    expect(r).toContain("avg PnL");
  });

  it("keeps a (wallet, side) that wins on average", () => {
    expect(walletCopySkipReason({ ...base, side: "SELL", count: 5, avgPnl: 0.3 })).toBeNull();
  });

  it("does NOT drop a losing side before minWalletCopyCount (let it prove itself)", () => {
    expect(walletCopySkipReason({ ...base, side: "BUY", count: 2, avgPnl: -0.4 })).toBeNull();
  });

  it("catastrophic-loss stop: drops wallet entirely once total PnL < maxWalletLoss", () => {
    const r = walletCopySkipReason({ ...base, totalPnl: -5 });
    expect(r).toContain("catastrophic-loss stop");
  });

  it("diversification cap: skips when wallet hits maxCopiesPerWallet", () => {
    const r = walletCopySkipReason({ ...base, openCount: DEFAULT_RULES.maxCopiesPerWallet });
    expect(r).toContain("diversification cap");
  });

  it("catastrophic stop takes priority over per-side performance", () => {
    const r = walletCopySkipReason({ ...base, totalPnl: -10, side: "SELL", count: 5, avgPnl: 0.3 });
    expect(r).toContain("catastrophic-loss stop");
  });
});
