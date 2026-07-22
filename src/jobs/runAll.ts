// Job: pipeline. Run the research loop in order.
import { runScanLeaderboard } from "./scanLeaderboard.js";
import { runScanWallets } from "./scanWallets.js";
import { runMonitorTrades } from "./monitorTrades.js";
import { runScoreTrades } from "./scoreTrades.js";
import { runScanPoliticalFavorites } from "./scanPoliticalFavorites.js";
import { runScanCalendarArbitrage } from "./scanCalendarArbitrage.js";
import { runPaperUpdatePnl } from "./paperUpdatePnl.js";
import { runReviewOutcomes } from "./reviewOutcomes.js";
import { runUpdateRules } from "./updateRules.js";
import { runReportDaily } from "./reportDaily.js";

interface StepResult {
  name: string;
  success: boolean;
  error?: string;
  critical: boolean;
}

const steps: [string, () => Promise<void>, boolean][] = [
  ["update:rules", runUpdateRules, true],              // FIRST: sync DB rules before scoring
  ["scan:leaderboard", runScanLeaderboard, true],
  ["scan:wallets", runScanWallets, true],
  ["monitor:trades", runMonitorTrades, true],
  ["score:trades", runScoreTrades, false],
  ["scan:politics", async () => { await runScanPoliticalFavorites(); }, false],
  ["scan:calendar", async () => { await runScanCalendarArbitrage(); }, false],
  ["paper:update-pnl", runPaperUpdatePnl, false],
  ["review:outcomes", runReviewOutcomes, false],
  ["report:daily", runReportDaily, false],
];

export interface PipelineResult {
  success: boolean;
  results: StepResult[];
  failedCritical: string[];
  failedNonCritical: string[];
}

export async function runPipeline(): Promise<PipelineResult> {
  const results: StepResult[] = [];
  let criticalFailure = false;

  for (const [name, fn, isCritical] of steps) {
    try {
      console.log(`\n=== ${name} ===`);
      await fn();
      results.push({ name, success: true, critical: isCritical });
    } catch (e) {
      const errorMsg = (e as Error).message;
      results.push({ name, success: false, error: errorMsg, critical: isCritical });
      console.error(`${name} FAILED${isCritical ? " [CRITICAL]" : ""}:`, errorMsg);
      if (isCritical) criticalFailure = true;
    }
  }

  const failedCritical = results.filter((r) => !r.success && r.critical).map((r) => r.name);
  const failedNonCritical = results.filter((r) => !r.success && !r.critical).map((r) => r.name);

  console.log("\n========== PIPELINE SUMMARY ==========");
  if (failedCritical.length) console.log(`CRITICAL FAILURES: ${failedCritical.join(", ")}`);
  if (failedNonCritical.length) console.log(`Non-critical failures: ${failedNonCritical.join(", ")}`);
  if (!failedCritical.length && !failedNonCritical.length) console.log("All steps completed successfully.");
  console.log("=======================================\n");

  return { success: !criticalFailure, results, failedCritical, failedNonCritical };
}

if (require.main === module) {
  runPipeline()
    .then((result) => {
      if (!result.success) {
        console.error("Pipeline completed with critical failures");
        process.exitCode = 1;
      }
    })
    .catch((e) => {
      console.error("Pipeline crashed:", e);
      process.exitCode = 1;
    });
}
