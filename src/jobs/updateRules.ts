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
// IMPORTANT: This job also SYNCs the DB ruleset with code defaults.
// If DEFAULT_RULES in scoring.ts is updated (e.g. widened liquidity band),
// the DB must be updated too — otherwise scoreTrades loads stale values.
import { prisma } from "../lib/db.js";
import { DEFAULT_RULES } from "../lib/scoring.js";

export async function runUpdateRules(): Promise<void> {
  const currentRow = await prisma.ruleSet.findFirst({ where: { active: true }, orderBy: { version: "desc" } });

  if (!currentRow) {
    await prisma.ruleSet.create({
      data: { version: 1, active: true, rulesJson: JSON.stringify(DEFAULT_RULES) },
    });
    console.log("updateRules: created initial ruleset v1 (synced with code defaults)");
    return;
  }

  // Sync check: if DB rules differ from code defaults, create a new version.
  // This fixes the bug where code was updated (10K-500K liquidity) but DB still
  // had old values (89K-207K), causing 135+ trades to be incorrectly skipped.
  let dbRules: Record<string, unknown>;
  try {
    dbRules = JSON.parse(currentRow.rulesJson);
  } catch {
    dbRules = {};
  }

  const codeRules = DEFAULT_RULES as unknown as Record<string, unknown>;
  const diffs: string[] = [];
  for (const key of Object.keys(codeRules)) {
    if (dbRules[key] !== codeRules[key]) {
      diffs.push(`${key}: ${dbRules[key]} → ${codeRules[key]}`);
    }
  }

  if (diffs.length > 0) {
    const newVersion = currentRow.version + 1;
    await prisma.ruleSet.update({ where: { id: currentRow.id }, data: { active: false } });
    await prisma.ruleSet.create({
      data: { version: newVersion, active: true, rulesJson: JSON.stringify(DEFAULT_RULES) },
    });
    console.log(`updateRules: synced DB → v${newVersion} (${diffs.length} fields updated)`);
    for (const d of diffs.slice(0, 5)) console.log(`  ${d}`);
    if (diffs.length > 5) console.log(`  ...and ${diffs.length - 5} more`);
    return;
  }

  console.log(`updateRules: rules at v${currentRow.version}, in sync with code (no changes)`);
}

if (require.main === module) runUpdateRules().catch(console.error);
