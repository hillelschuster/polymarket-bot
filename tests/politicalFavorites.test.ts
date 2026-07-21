import { describe, expect, it } from "vitest";
import { CATEGORY_FAVORITE_GATES, DEFAULT_RULES, getFavoriteGate, scoreTrade } from "../src/lib/scoring.js";
import {
  calibratedPoliticalProbability,
  MAX_FAVORITE_PRICE,
  MAX_LIQUIDITY,
  MAX_SPREAD,
  MIN_FAVORITE_PRICE,
  MIN_LIQUIDITY,
} from "../src/jobs/scanPoliticalFavorites.js";

describe("category-aware wallet gates", () => {
  it("keeps the existing wallet-pipeline category gates", () => {
    expect(CATEGORY_FAVORITE_GATES.politics).toBe(0.55);
    expect(CATEGORY_FAVORITE_GATES.sports).toBe(0.65);
    expect(getFavoriteGate(null)).toBe(0.60);
  });

  it("applies the category gate in scoreTrade", () => {
    const rules = { ...DEFAULT_RULES, minMarketLiquidity: 0, maxMarketLiquidity: 0 };
    const base = {
      walletGlobalScore: 50,
      priceMovementSinceEntry: 0.02,
      spread: 0.02,
      liquidity: 150_000,
      volume: 0,
      timeToResolution: 15,
      side: "BUY",
    };
    expect(scoreTrade({ ...base, currentPrice: 0.56, category: "politics" }, rules).decision).toBe("paper_copy");
    expect(scoreTrade({ ...base, currentPrice: 0.54, category: "politics" }, rules).decision).toBe("skip");
  });
});

describe("political scanner profit gates", () => {
  it("uses the tighter executable range", () => {
    expect(MIN_FAVORITE_PRICE).toBe(0.65);
    expect(MAX_FAVORITE_PRICE).toBe(0.82);
    expect(MAX_SPREAD).toBe(0.02);
  });

  it("uses the intended liquidity band", () => {
    expect(MIN_LIQUIDITY).toBe(10_000);
    expect(MAX_LIQUIDITY).toBe(500_000);
  });

  it("calibration raises favorite probability without adding a fixed percentage", () => {
    expect(calibratedPoliticalProbability(0.65)).toBeGreaterThan(0.65);
    expect(calibratedPoliticalProbability(0.80)).toBeGreaterThan(0.80);
    expect(calibratedPoliticalProbability(0.50)).toBeCloseTo(0.50);
  });
});
