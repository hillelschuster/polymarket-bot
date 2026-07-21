// Job: pipeline. Run the full research loop in order. SPEC §10,§14.
//
// Error handling policy:
// - CRITICAL steps (data fetching): failure invalidates the run. Downstream steps
//   that depend on fresh data should not run with stale data.
// - NON-CRITICAL steps (analytics, reporting): failure is logged but doesn't abort.
//
// This prevents the bug where a failed market-price refresh silently preserves
// stale marks, combining fresh and stale data in the same report.
import { runScanLeaderboard } from "./scanLeaderboard.js";
import { runScanWallets } from "./scanWallets.js";
import { runMonitorTrades } from "./monitorTrades.js";
import { runScoreTrades } from "./scoreTrades.js";
import { runScanPoliticalFavorites } from "./scanPoliticalFavorites.js";
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

// Steps marked critical: if these fail, downstream steps may produce invalid results
const steps: [string, () => Promise<void>, boolean][] = [
  ["scan:leaderboard", runScanLeaderboard, true],      // CRITICAL: wallet data source
  ["scan:wallets", runScanWallets, true],              // CRITICAL: wallet scoring
  ["monitor:trades", runMonitorTrades, true],          // CRITICAL: trade data source
  ["score:trades", runScoreTrades, false],             // Analytics: can skip
  ["scan:politics", async () => { await runScanPoliticalFavorites(); }, true], // CRITICAL: political scanner
  ["paper:update-pnl", runPaperUpdatePnl, false],      // Analytics: can use stale marks briefly
  ["review:outcomes", runReviewOutcomes, false],       // Resolution: can retry next pass
  ["update:rules", runUpdateRules, false],             // Learning: disabled anyway
  ["report:daily", runReportDaily, false],             // Reporting: can skip
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
    // Skip non-critical steps if a critical step already failed
    // (prevents combining fresh and stale data)
    if (criticalFailure && !isCritical) {
      results.push({ name, success: false, error: "skipped (critical step failed)", critical: false });
      console.log(`\n=== ${name} === SKIPPED (critical step failed)`);
      continue;
    }

    try {
      console.log(`\n=== ${name} ===`);
      await fn();
      results.push({ name, success: true, critical: isCritical });
    } catch (e) {
      const errorMsg = (e as Error).message;
      results.push({ name, success: false, error: errorMsg, critical: isCritical });
      console.error(`${name} FAILED${isCritical ? ' [CRITICAL]' : ''}:`, errorMsg);
      if (isCritical) {
        criticalFailure = true;
      }
    }
  }

  const failedCritical = results.filter(r => !r.success && r.critical).map(r => r.name);
  const failedNonCritical = results.filter(r => !r.success && !r.critical).map(r => r.name);

  console.log("\n========== PIPELINE SUMMARY ==========");
  if (failedCritical.length > 0) {
    console.log(`CRITICAL FAILURES: ${failedCritical.join(", ")}`);
    console.log("Run invalidated — downstream steps skipped to prevent stale data.");
  }
  if (failedNonCritical.length > 0) {
    console.log(`Non-critical failures: ${failedNonCritical.join(", ")}`);
  }
  if (failedCritical.length === 0 && failedNonCritical.length === 0) {
    console.log("All steps completed successfully.");
  }
  console.log("=======================================\n");

  return {
    success: failedCritical.length === 0,
    results,
    failedCritical,
    failedNonCritical,
  };
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
