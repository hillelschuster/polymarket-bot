import { describe, expect, it } from "vitest";
import { liveCashBudgetForPaper, liveLimitReason } from "../src/lib/liveLimits.js";

const limits = {
  maxOpenPositions: 10,
  maxPositionUsd: 10,
  maxExposureUsd: 100,
};

describe("live order limits", () => {
  it("allows a position within all configured limits", () => {
    expect(liveLimitReason({ openPositions: 9, exposureUsd: 90, cashBudget: 10 }, limits)).toBeNull();
  });

  it("blocks a position above the requested per-position size", () => {
    expect(liveLimitReason({ openPositions: 0, exposureUsd: 0, cashBudget: 10.01 }, limits)).toBe("position-size-cap");
  });

  it("blocks the eleventh open position", () => {
    expect(liveLimitReason({ openPositions: 10, exposureUsd: 90, cashBudget: 10 }, limits)).toBe("open-position-cap");
  });

  it("blocks exposure above the bankroll allocation", () => {
    expect(liveLimitReason({ openPositions: 9, exposureUsd: 95, cashBudget: 10 }, limits)).toBe("exposure-cap");
  });

  it("scales the paper position proportionally to a $10 live maximum", () => {
    expect(liveCashBudgetForPaper(5, 10)).toBe(2.5);
    expect(liveCashBudgetForPaper(10, 10)).toBe(5);
    expect(liveCashBudgetForPaper(15, 10)).toBe(7.5);
    expect(liveCashBudgetForPaper(20, 10)).toBe(10);
  });

  it("never maps a paper amount above the current paper maximum above the live cap", () => {
    expect(liveCashBudgetForPaper(25, 10)).toBe(10);
  });
});
