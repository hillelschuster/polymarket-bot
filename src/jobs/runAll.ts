// Job: pipeline. Dual-path architecture for maximum signal freshness.
//
// FAST PATH (every ~7 min): detect + copy trades while signals are fresh.
//   monitor:trades → score:trades → paper:update-pnl → review:outcomes
//
// SLOW PATH (every ~30 min): refresh wallet intelligence.
//   update:rules → scan:leaderboard → scan:wallets → scan:politics → scan:calendar → report:daily
//
// The fast path runs FIRST and ALWAYS — signal age was the #1 rejection reason (45%).
// The slow path runs independently and never blocks trade detection.
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

// Fast path: signal detection + execution (runs every FAST_INTERVAL)
const fastSteps: [string, () => Promise<void>, boolean][] = [
  ["monitor:trades", runMonitorTrades, true],
  ["score:trades", runScoreTrades, false],
  ["paper:update-pnl", runPaperUpdatePnl, false],
  ["review:outcomes", runReviewOutcomes, false],
];

// Slow path: wallet intelligence refresh (runs every SLOW_INTERVAL)
const slowSteps: [string, () => Promise<void>, boolean][] = [
  ["update:rules", runUpdateRules, true],
  ["scan:leaderboard", runScanLeaderboard, true],
  ["scan:wallets", runScanWallets, true],
  ["scan:politics", async () => { await runScanPoliticalFavorites(); }, false],
  ["scan:calendar", async () => { await runScanCalendarArbitrage(); }, false],
  ["report:daily", runReportDaily, false],
];

export interface PipelineResult {
  success: boolean;
  results: StepResult[];
  failedCritical: string[];
  failedNonCritical: string[];
}

async function runSteps(steps: [string, () => Promise<void>, boolean][]): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const [name, fn, isCritical] of steps) {
    try {
      console.log(`\n=== ${name} ===`);
      await fn();
      results.push({ name, success: true, critical: isCritical });
    } catch (e) {
      const errorMsg = (e as Error).message;
      results.push({ name, success: false, error: errorMsg, critical: isCritical });
      console.error(`${name} FAILED${isCritical ? " [CRITICAL]" : ""}:`, errorMsg);
    }
  }
  return results;
}

/** Fast path only — detect and copy trades while signals are fresh. */
export async function runFastPath(): Promise<PipelineResult> {
  const results = await runSteps(fastSteps);
  const failedCritical = results.filter((r) => !r.success && r.critical).map((r) => r.name);
  const failedNonCritical = results.filter((r) => !r.success && !r.critical).map((r) => r.name);
  if (failedCritical.length) console.log(`FAST PATH CRITICAL FAILURES: ${failedCritical.join(", ")}`);
  return { success: !failedCritical.length, results, failedCritical, failedNonCritical };
}

/** Slow path only — refresh wallet intelligence, rules, reports. */
export async function runSlowPath(): Promise<PipelineResult> {
  const results = await runSteps(slowSteps);
  const failedCritical = results.filter((r) => !r.success && r.critical).map((r) => r.name);
  const failedNonCritical = results.filter((r) => !r.success && !r.critical).map((r) => r.name);
  if (failedCritical.length) console.log(`SLOW PATH CRITICAL FAILURES: ${failedCritical.join(", ")}`);
  return { success: !failedCritical.length, results, failedCritical, failedNonCritical };
}

/** Full pipeline (backward compat) — fast then slow. */
export async function runPipeline(): Promise<PipelineResult> {
  const fast = await runFastPath();
  const slow = await runSlowPath();
  const results = [...fast.results, ...slow.results];
  const failedCritical = [...fast.failedCritical, ...slow.failedCritical];
  const failedNonCritical = [...fast.failedNonCritical, ...slow.failedNonCritical];

  console.log("\n========== PIPELINE SUMMARY ==========");
  if (failedCritical.length) console.log(`CRITICAL FAILURES: ${failedCritical.join(", ")}`);
  if (failedNonCritical.length) console.log(`Non-critical failures: ${failedNonCritical.join(", ")}`);
  if (!failedCritical.length && !failedNonCritical.length) console.log("All steps completed successfully.");
  console.log("=======================================\n");

  return { success: !failedCritical.length, results, failedCritical, failedNonCritical };
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
