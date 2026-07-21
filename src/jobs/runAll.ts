// Job: pipeline. Run the full research loop in order. SPEC §10,§14.
// Each step is isolated; a failure is logged and the loop continues so one bad
// API call doesn't abort the whole run.
import { runScanLeaderboard } from "./scanLeaderboard.js";
import { runScanWallets } from "./scanWallets.js";
import { runMonitorTrades } from "./monitorTrades.js";
import { runScoreTrades } from "./scoreTrades.js";
import { runScanPoliticalFavorites } from "./scanPoliticalFavorites.js";
import { runPaperUpdatePnl } from "./paperUpdatePnl.js";
import { runReviewOutcomes } from "./reviewOutcomes.js";
import { runUpdateRules } from "./updateRules.js";
import { runReportDaily } from "./reportDaily.js";

const steps: [string, () => Promise<void>][] = [
  ["scan:leaderboard", runScanLeaderboard],
  ["scan:wallets", runScanWallets],
  ["monitor:trades", runMonitorTrades],
  ["score:trades", runScoreTrades],
  ["scan:politics", async () => { await runScanPoliticalFavorites(); }],
  ["paper:update-pnl", runPaperUpdatePnl],
  ["review:outcomes", runReviewOutcomes],
  ["update:rules", runUpdateRules],
  ["report:daily", runReportDaily],
];

export async function runPipeline(): Promise<void> {
  for (const [name, fn] of steps) {
    try {
      console.log(`\n=== ${name} ===`);
      await fn();
    } catch (e) {
      console.error(`${name} failed:`, (e as Error).message);
    }
  }
  console.log("\npipeline complete");
}

if (require.main === module) runPipeline().catch(console.error);
