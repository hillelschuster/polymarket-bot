// Job: update:rules. DISABLED — deterministic rules only. SPEC §7,§10.
// 
// The previous "self-learning" logic fabricated evidence from trade counts
// rather than performing causal analysis. This has been disabled to prevent
// rule drift based on spurious correlations.
//
// Rules should only change via:
// 1. Manual intervention with explicit reasoning
// 2. Statistically significant backtest results (not implemented)
//
import { prisma } from "../lib/db.js";
import { createInitialRuleSet } from "../lib/rules.js";

export async function runUpdateRules(): Promise<void> {
  const currentRow = await prisma.ruleSet.findFirst({ where: { active: true }, orderBy: { version: "desc" } });
  
  if (!currentRow) {
    // Create initial ruleset if none exists
    const defaultRulesValues = (await import("../lib/scoring.js")).DEFAULT_RULES;
    await prisma.ruleSet.create({
      data: { version: 1, active: true, rulesJson: JSON.stringify(defaultRulesValues) },
    });
    console.log("updateRules: created initial ruleset (learning disabled)");
    return;
  }

  // Learning disabled — rules remain static until manually changed
  console.log(`updateRules: learning disabled, rules at v${currentRow.version} (no changes)`);
}

if (require.main === module) runUpdateRules().catch(console.error);
