// Tests: rule versioning, automatic threshold changes + logging. SPEC §15.
import { describe, it, expect } from "vitest";
import { updateRules, createInitialRuleSet } from "../src/lib/rules.js";

describe("updateRules", () => {
  it("returns unchanged ruleset when evidence is benign", () => {
    const rules = createInitialRuleSet(1);
    const { ruleset, changes } = updateRules(rules, {
      spreadHeavyLossPnL: 0,
      lowLiquidityLossPnL: 0,
      lateEntryLossPnL: 0,
      highRoiVolatileWinPnL: 10,
      totalBotPnL: 100,
      totalBlindPnL: 50,
    });
    expect(changes).toHaveLength(0);
    expect(ruleset.version).toBe(1);
  });

  it("bumps version and returns changes when adjustment needed", () => {
    const rules = createInitialRuleSet(3);
    const { ruleset, changes } = updateRules(rules, {
      spreadHeavyLossPnL: -50,
      lowLiquidityLossPnL: 0,
      lateEntryLossPnL: 0,
      highRoiVolatileWinPnL: 10,
      totalBotPnL: -100,
      totalBlindPnL: -200,
    });
    expect(ruleset.version).toBe(4);
    expect(changes).toHaveLength(1);
    expect(changes[0].oldRuleSetId).toBe("v3");
    expect(changes[0].newRuleSetId).toBe("v4");
    expect(changes[0].changedBy).toBe("auto");
  });

  it("lowers maxSpread on spread-heavy losses", () => {
    const rules = createInitialRuleSet(1);
    const { ruleset } = updateRules(rules, {
      spreadHeavyLossPnL: -50,
      lowLiquidityLossPnL: 0,
      lateEntryLossPnL: 0,
      highRoiVolatileWinPnL: 10,
      totalBotPnL: 0,
      totalBlindPnL: 0,
    });
    expect(ruleset.rules.maxSpread).toBeLessThan(rules.rules.maxSpread);
  });

  it("raises minLiquidity on low-liquidity losses", () => {
    const rules = createInitialRuleSet(1);
    const minLiq = rules.rules.minLiquidity;
    const { ruleset } = updateRules(rules, {
      spreadHeavyLossPnL: 0,
      lowLiquidityLossPnL: -50,
      lateEntryLossPnL: 0,
      highRoiVolatileWinPnL: 10,
      totalBotPnL: 0,
      totalBlindPnL: 0,
    });
    expect(ruleset.rules.minLiquidity).toBeGreaterThan(minLiq);
  });

  it("lowers maxPriceMovement on late-entry losses", () => {
    const rules = createInitialRuleSet(1);
    const maxMov = rules.rules.maxPriceMovement;
    const { ruleset } = updateRules(rules, {
      spreadHeavyLossPnL: 0,
      lowLiquidityLossPnL: 0,
      lateEntryLossPnL: -50,
      highRoiVolatileWinPnL: 10,
      totalBotPnL: 0,
      totalBlindPnL: 0,
    });
    expect(ruleset.rules.maxPriceMovement).toBeLessThan(maxMov);
  });

  it("raises W_cons on volatile-wallet losses", () => {
    const rules = createInitialRuleSet(1);
    const wCons = rules.rules.W_cons;
    const { ruleset } = updateRules(rules, {
      spreadHeavyLossPnL: 0,
      lowLiquidityLossPnL: 0,
      lateEntryLossPnL: 0,
      highRoiVolatileWinPnL: -10,
      totalBotPnL: 0,
      totalBlindPnL: 0,
    });
    expect(ruleset.rules.W_cons).toBeGreaterThan(wCons);
  });

  it("lowers W_roi when volatile wallets lose", () => {
    const rules = createInitialRuleSet(1);
    const wRoi = rules.rules.W_roi;
    const { ruleset } = updateRules(rules, {
      spreadHeavyLossPnL: 0,
      lowLiquidityLossPnL: 0,
      lateEntryLossPnL: 0,
      highRoiVolatileWinPnL: -10,
      totalBotPnL: 0,
      totalBlindPnL: 0,
    });
    expect(ruleset.rules.W_roi).toBeLessThan(wRoi);
  });

  it("records beforeJson and afterJson in the change", () => {
    const rules = createInitialRuleSet(1);
    const { changes } = updateRules(rules, { spreadHeavyLossPnL: -50, lowLiquidityLossPnL: 0, lateEntryLossPnL: 0, highRoiVolatileWinPnL: 10, totalBotPnL: 0, totalBlindPnL: 0 });
    expect(changes[0].beforeJson).toBe(JSON.stringify(rules.rules));
    expect(changes[0].afterJson).not.toBe(changes[0].beforeJson);
  });

  it("is deterministic — same input = same output", () => {
    const rules = createInitialRuleSet(1);
    const evidence = { spreadHeavyLossPnL: -50, lowLiquidityLossPnL: 0, lateEntryLossPnL: 0, highRoiVolatileWinPnL: 10, totalBotPnL: 0, totalBlindPnL: 0 };
    const r1 = updateRules(rules, evidence);
    const r2 = updateRules(rules, evidence);
    expect(r1.ruleset.rules.maxSpread).toBe(r2.ruleset.rules.maxSpread);
    expect(r1.changes[0].afterJson).toBe(r2.changes[0].afterJson);
  });

  it("tightens wallet floor when aggregate unrealized PnL is losing", () => {
    const rules = createInitialRuleSet(1);
    const { ruleset, changes } = updateRules(rules, {
      spreadHeavyLossPnL: 0, lowLiquidityLossPnL: 0, lateEntryLossPnL: 0,
      highRoiVolatileWinPnL: 10, totalBotPnL: -50, totalBlindPnL: -50,
      aggregateUnrealizedPnL: -20,
    });
    expect(changes.length).toBeGreaterThan(0);
    expect(ruleset.rules.minWalletGlobal).toBeGreaterThan(rules.rules.minWalletGlobal);
  });

  it("loosens wallet floor when aggregate unrealized PnL is winning", () => {
    const rules = createInitialRuleSet(1);
    const { ruleset, changes } = updateRules(rules, {
      spreadHeavyLossPnL: 0, lowLiquidityLossPnL: 0, lateEntryLossPnL: 0,
      highRoiVolatileWinPnL: 10, totalBotPnL: 50, totalBlindPnL: 50,
      aggregateUnrealizedPnL: 20,
    });
    expect(changes.length).toBeGreaterThan(0);
    expect(ruleset.rules.minWalletGlobal).toBeLessThan(rules.rules.minWalletGlobal);
  });
});
