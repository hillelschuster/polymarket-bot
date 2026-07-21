// Job: update:rules. Self-improve thresholds deterministically. SPEC §7,§10.
import { prisma } from "../lib/db.js";
import { updateRules, createInitialRuleSet, type RuleEvidence } from "../lib/rules.js";

export async function runUpdateRules(): Promise<void> {
  const currentRow = await prisma.ruleSet.findFirst({ where: { active: true }, orderBy: { version: "desc" } });
  const defaultRulesValues = (await import("../lib/scoring.js")).DEFAULT_RULES;
  let currentRules;
  if (currentRow) {
    currentRules = {
      version: currentRow.version,
      active: currentRow.active,
      rules: JSON.parse(currentRow.rulesJson),
      createdAt: currentRow.createdAt.getTime(),
      updatedAt: currentRow.updatedAt.getTime(),
    };
  } else {
    currentRules = createInitialRuleSet(1, true);
    currentRules.createdAt = Date.now();
    currentRules.updatedAt = Date.now();
    await prisma.ruleSet.create({
      data: { version: 1, active: true, rulesJson: JSON.stringify(defaultRulesValues) },
    });
    console.log("updateRules: created initial ruleset");
    return;
  }

  // Gather evidence from recent outcome reviews
  const reviews = await prisma.outcomeReview.findMany({
    where: { wasDecisionGood: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const bad = reviews.filter((r) => !r.wasDecisionGood);
  const evidence: RuleEvidence = {
    spreadHeavyLossPnL: bad.length > 3 ? -15 : 0,
    lowLiquidityLossPnL: bad.length > 5 ? -20 : 0,
    lateEntryLossPnL: bad.length > 2 ? -12 : 0,
    highRoiVolatileWinPnL: reviews.filter((r) => r.wasDecisionGood).length > 10 ? 20 : -5,
    totalBotPnL: reviews.reduce((s, r) => s + (r.simulatedPnl ?? 0), 0),
    totalBlindPnL: reviews.reduce((s, r) => s + (r.simulatedPnl ?? 0), 0), // ponytail: blind = same data for now
    aggregateUnrealizedPnL: 0,
  };

  // Learn from live unrealized PnL on open positions, not just resolved outcomes.
  const openTrades = await prisma.paperTrade.findMany({
    where: { status: "open" },
    include: { decisionJournal: { include: { observedTrade: true } } },
  });
  let spreadLoss = 0;
  let liqLoss = 0;
  for (const t of openTrades) {
    const pnl = t.unrealizedPnl ?? 0;
    const spread = t.decisionJournal?.observedTrade?.marketSpread ?? 0;
    const liq = t.decisionJournal?.observedTrade?.marketLiquidity ?? 0;
    if (spread > currentRules.rules.maxSpread && pnl < 0) spreadLoss += pnl;
    if (liq < currentRules.rules.minLiquidity && pnl < 0) liqLoss += pnl;
  }
  if (spreadLoss < -5) evidence.spreadHeavyLossPnL = Math.min(evidence.spreadHeavyLossPnL, spreadLoss);
  if (liqLoss < -5) evidence.lowLiquidityLossPnL = Math.min(evidence.lowLiquidityLossPnL, liqLoss);

  // Core self-learning signal: aggregate unrealized PnL across open positions.
  evidence.aggregateUnrealizedPnL = openTrades.reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);

  const result = updateRules(currentRules, evidence);
  if (result.changes.length === 0) {
    console.log("updateRules: no changes needed");
    return;
  }

  const newRow = await prisma.ruleSet.create({
    data: {
      version: result.ruleset.version,
      active: true,
      rulesJson: JSON.stringify(result.ruleset.rules),
    },
  });
  await prisma.ruleSet.update({ where: { id: currentRow!.id }, data: { active: false } });

  for (const ch of result.changes) {
    await prisma.ruleChange.create({
      data: {
        oldRuleSetId: currentRow!.id,
        newRuleSetId: newRow.id,
        changedBy: ch.changedBy,
        reason: ch.reason,
        evidenceSummary: ch.evidenceSummary,
        beforeJson: ch.beforeJson,
        afterJson: ch.afterJson,
      },
    });
  }
  console.log(`updateRules done: v${currentRules.version} -> v${result.ruleset.version}`);
}

if (require.main === module) runUpdateRules().catch(console.error);
