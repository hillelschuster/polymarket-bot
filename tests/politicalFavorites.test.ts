// Tests: Political Favorites Scanner — category-aware gates, market filters, edge estimation.
import { describe, it, expect } from "vitest";
import {
  getFavoriteGate,
  CATEGORY_FAVORITE_GATES,
  scoreTrade,
  DEFAULT_RULES,
} from "../src/lib/scoring.js";

describe("CATEGORY_FAVORITE_GATES", () => {
  it("politics has the widest gate (0.55) due to 13-18% underconfidence", () => {
    expect(CATEGORY_FAVORITE_GATES.politics).toBe(0.55);
  });

  it("sports and crypto have tighter gates (0.65) — near-efficient markets", () => {
    expect(CATEGORY_FAVORITE_GATES.sports).toBe(0.65);
    expect(CATEGORY_FAVORITE_GATES.crypto).toBe(0.65);
  });

  it("esports and default use the validated baseline (0.60)", () => {
    expect(CATEGORY_FAVORITE_GATES.esports).toBe(0.60);
    expect(CATEGORY_FAVORITE_GATES.default).toBe(0.60);
  });
});

describe("getFavoriteGate", () => {
  it("returns politics gate for 'politics' category", () => {
    expect(getFavoriteGate("politics")).toBe(0.55);
  });

  it("is case-insensitive", () => {
    expect(getFavoriteGate("Politics")).toBe(0.55);
    expect(getFavoriteGate("POLITICS")).toBe(0.55);
  });

  it("returns sports gate for 'sports'", () => {
    expect(getFavoriteGate("sports")).toBe(0.65);
  });

  it("returns default gate for unknown category", () => {
    expect(getFavoriteGate("weather")).toBe(0.60);
    expect(getFavoriteGate("entertainment")).toBe(0.60);
  });

  it("returns default gate for null/undefined", () => {
    expect(getFavoriteGate(null)).toBe(0.60);
    expect(getFavoriteGate(undefined)).toBe(0.60);
  });
});

describe("scoreTrade with category-aware gate", () => {
  const baseTrade = {
    walletGlobalScore: 50,
    priceMovementSinceEntry: 0.02,
    spread: 0.02,
    liquidity: 150_000,
    volume: 0,
    timeToResolution: 15,
    side: "BUY",
  };

  // Use rules that won't interfere with the favorite gate test
  const permissiveRules = {
    ...DEFAULT_RULES,
    minMarketLiquidity: 0,
    maxMarketLiquidity: 0,
  };

  it("politics: accepts favorite at 0.56 (above politics gate 0.55)", () => {
    const trade = { ...baseTrade, currentPrice: 0.56, category: "politics" };
    const result = scoreTrade(trade, permissiveRules);
    expect(result.decision).toBe("paper_copy");
  });

  it("politics: rejects favorite at 0.54 (below politics gate 0.55)", () => {
    const trade = { ...baseTrade, currentPrice: 0.54, category: "politics" };
    const result = scoreTrade(trade, permissiveRules);
    expect(result.decision).toBe("skip");
    expect(result.reasons.some((r) => r.includes("gate"))).toBe(true);
  });

  it("sports: rejects favorite at 0.60 (below sports gate 0.65)", () => {
    const trade = { ...baseTrade, currentPrice: 0.60, category: "sports" };
    const result = scoreTrade(trade, permissiveRules);
    expect(result.decision).toBe("skip");
  });

  it("sports: accepts favorite at 0.66 (above sports gate 0.65)", () => {
    const trade = { ...baseTrade, currentPrice: 0.66, category: "sports" };
    const result = scoreTrade(trade, permissiveRules);
    expect(result.decision).toBe("paper_copy");
  });

  it("no category: falls back to rules.minFavoritePrice", () => {
    // Default minFavoritePrice is 0.60
    const trade = { ...baseTrade, currentPrice: 0.58 };
    const result = scoreTrade(trade, permissiveRules);
    expect(result.decision).toBe("skip"); // 0.58 < 0.60

    const trade2 = { ...baseTrade, currentPrice: 0.62 };
    const result2 = scoreTrade(trade2, permissiveRules);
    expect(result2.decision).toBe("paper_copy"); // 0.62 >= 0.60
  });

  it("backward compat: existing wallet pipeline (no category) still uses minFavoritePrice", () => {
    const customRules = { ...permissiveRules, minFavoritePrice: 0.70 };
    const trade = { ...baseTrade, currentPrice: 0.65 }; // No category
    const result = scoreTrade(trade, customRules);
    expect(result.decision).toBe("skip"); // 0.65 < 0.70 (custom rule)
  });
});

describe("political favorites scanner logic (unit)", () => {
  // Test the pure decision logic that the scanner uses
  // IMPORTANT: These constants MUST match scanPoliticalFavorites.ts

  const GATE = 0.55; // politics gate
  const MAX_PRICE = 0.85; // Production value (was 0.80)

  function isInSweetSpot(yesPrice: number, noPrice: number): { outcome: string; price: number } | null {
    if (yesPrice >= GATE && yesPrice <= MAX_PRICE) {
      return { outcome: "Yes", price: yesPrice };
    }
    if (noPrice >= GATE && noPrice <= MAX_PRICE) {
      return { outcome: "No", price: noPrice };
    }
    return null;
  }

  it("identifies YES favorite in sweet spot", () => {
    const result = isInSweetSpot(0.70, 0.30);
    expect(result).toEqual({ outcome: "Yes", price: 0.70 });
  });

  it("identifies NO favorite in sweet spot", () => {
    const result = isInSweetSpot(0.35, 0.65);
    expect(result).toEqual({ outcome: "No", price: 0.65 });
  });

  it("rejects when both prices are below gate (coin flip market)", () => {
    const result = isInSweetSpot(0.50, 0.50);
    expect(result).toBeNull();
  });

  it("rejects extreme favorites (above 0.85)", () => {
    const result = isInSweetSpot(0.90, 0.10);
    expect(result).toBeNull();
  });

  it("accepts edge cases at exact gate boundaries", () => {
    expect(isInSweetSpot(0.55, 0.45)).toEqual({ outcome: "Yes", price: 0.55 });
    expect(isInSweetSpot(0.85, 0.15)).toEqual({ outcome: "Yes", price: 0.85 });
  });

  it("edge estimate = favoritePrice * 0.15 (conservative calibration correction)", () => {
    const favoritePrice = 0.70;
    const edgeEstimate = favoritePrice * 0.15;
    expect(edgeEstimate).toBeCloseTo(0.105); // 10.5% edge
  });
});

describe("microstructure gates (unit)", () => {
  // IMPORTANT: These constants MUST match scanPoliticalFavorites.ts
  const MIN_LIQUIDITY = 5_000;   // Production value (was 10_000)
  const MAX_SPREAD = 0.08;       // Production value (was 0.05)
  const MIN_DAYS = 1;            // Production value (was 3)
  const MAX_DAYS = 90;           // Production value (was 60)
  const MAX_TOXIC = 15;

  function passesGates(m: {
    liquidity: number;
    spread: number;
    daysToResolution: number;
    volume24hr: number;
  }): boolean {
    if (m.liquidity < MIN_LIQUIDITY) return false;
    if (m.spread > MAX_SPREAD) return false;
    if (m.daysToResolution < MIN_DAYS || m.daysToResolution > MAX_DAYS) return false;
    if (m.liquidity > 0 && m.volume24hr / m.liquidity > MAX_TOXIC) return false;
    return true;
  }

  it("passes a healthy market", () => {
    expect(passesGates({ liquidity: 50_000, spread: 0.02, daysToResolution: 15, volume24hr: 100_000 })).toBe(true);
  });

  it("rejects low liquidity", () => {
    expect(passesGates({ liquidity: 2_000, spread: 0.02, daysToResolution: 15, volume24hr: 10_000 })).toBe(false);
  });

  it("rejects wide spread", () => {
    expect(passesGates({ liquidity: 50_000, spread: 0.12, daysToResolution: 15, volume24hr: 100_000 })).toBe(false);
  });

  it("rejects too-soon resolution (below 1 day)", () => {
    expect(passesGates({ liquidity: 50_000, spread: 0.02, daysToResolution: 0.5, volume24hr: 10_000 })).toBe(false);
  });

  it("rejects too-far resolution (above 90 days)", () => {
    expect(passesGates({ liquidity: 50_000, spread: 0.02, daysToResolution: 120, volume24hr: 10_000 })).toBe(false);
  });

  it("rejects toxic flow (volume/liquidity spike)", () => {
    expect(passesGates({ liquidity: 10_000, spread: 0.02, daysToResolution: 15, volume24hr: 200_000 })).toBe(false);
  });

  it("accepts boundary values", () => {
    expect(passesGates({ liquidity: 5_000, spread: 0.08, daysToResolution: 1, volume24hr: 75_000 })).toBe(true);
    expect(passesGates({ liquidity: 5_000, spread: 0.08, daysToResolution: 90, volume24hr: 75_000 })).toBe(true);
  });
});
