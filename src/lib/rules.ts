// Rule engine: RuleSet type + deterministic updateRules. SPEC §7.
// No Math.random, no Date.now in logic (version bump only, no ID generation in pure fn).

import { RuleSetValues, DEFAULT_RULES } from "./scoring.js";

export interface RuleSet {
  version: number;
  active: boolean;
  rules: RuleSetValues;
  createdAt: number;   // epoch ms — set by caller, not by pure fn
  updatedAt: number;
}

export interface RuleChange {
  oldRuleSetId: string;
  newRuleSetId: string;
  changedBy: string;
  reason: string;
  evidenceSummary: string;
  beforeJson: string;
  afterJson: string;
}

export interface RuleEvidence {
  // Benchmark data — PnL by spread bucket, liquidity bucket, price-movement bucket
  spreadHeavyLossPnL: number;       // negative = losses from high-spread trades
  lowLiquidityLossPnL: number;      // negative = losses from low-liquidity trades
  lateEntryLossPnL: number;         // negative = losses from late-entry trades
  highRoiVolatileWinPnL: number;    // PnL from high-ROI-but-volatile wallets (if positive → keep, negative → tighten)
  totalBotPnL: number;
  totalBlindPnL: number;
  aggregateUnrealizedPnL?: number;    // sum of unrealized PnL on open paper positions (set by updateRules job)
}

/**
 * updateRules — DETERMINISTIC. Same inputs → same output.
 * Adjusts thresholds based on evidence, bumps version, logs before/after.
 */
export function updateRules(
  current: RuleSet,
  evidence: RuleEvidence,
): { ruleset: RuleSet; changes: RuleChange[] } {
  const before = { ...current.rules };
  const after = { ...before };
  const changes: RuleChange[] = [];
  const evidenceStr = JSON.stringify(evidence);

  // Spread-heavy losses → lower maxSpread
  if (evidence.spreadHeavyLossPnL < -10) {
    after.maxSpread = Math.max(0.01, +(before.maxSpread * 0.9).toFixed(4));
  }

  // Low-liquidity losses → raise minLiquidity
  if (evidence.lowLiquidityLossPnL < -10) {
    after.minLiquidity = Math.min(100_000, Math.round(before.minLiquidity * 1.1));
  }

  // Late-entry losses → lower maxPriceMovement
  if (evidence.lateEntryLossPnL < -10) {
    after.maxPriceMovement = Math.max(0.02, +(before.maxPriceMovement * 0.9).toFixed(4));
  }

  // Volatile high-ROI wallets losing → raise W_cons, lower W_roi
  if (evidence.highRoiVolatileWinPnL < -5) {
    after.W_cons = Math.min(0.5, +(before.W_cons + 0.05).toFixed(2));
    after.W_roi = Math.max(0.05, +(before.W_roi - 0.05).toFixed(2));
  }

  // Aggregate unrealized PnL on open positions → tighten wallet floor + copy gate
  // when the book is losing, loosen when winning. Core self-learning signal for a
  // paper-trading research bot (resolved outcomes are sparse early on).
  const aggUnreal = evidence.aggregateUnrealizedPnL ?? 0;
  if (aggUnreal < -5) {
    after.minWalletGlobal = Math.min(50, before.minWalletGlobal + 5);
    after.maxWalletLoss = Math.min(-1, before.maxWalletLoss + 1);
  } else if (aggUnreal > 5) {
    after.minWalletGlobal = Math.max(30, before.minWalletGlobal - 5);
    after.maxWalletLoss = Math.max(-10, before.maxWalletLoss - 1);
  }

  // Build before/after json
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);

  // Check if any change was made
  const hasChanges = beforeJson !== afterJson;

  if (hasChanges) {
    const newVersion = current.version + 1;
    const newRuleset: RuleSet = {
      ...current,
      version: newVersion,
      rules: after,
      updatedAt: current.updatedAt, // caller sets real timestamp
    };

    changes.push({
      oldRuleSetId: `v${current.version}`,
      newRuleSetId: `v${newVersion}`,
      changedBy: "auto",
      reason: "Automatic threshold adjustment based on benchmark evidence",
      evidenceSummary: evidenceStr,
      beforeJson,
      afterJson,
    });

    return { ruleset: newRuleset, changes };
  }

  return { ruleset: current, changes: [] };
}

/** Create an initial RuleSet with default values. */
export function createInitialRuleSet(version = 1, active = true): RuleSet {
  return {
    version,
    active,
    rules: { ...DEFAULT_RULES },
    createdAt: 0,
    updatedAt: 0,
  };
}
