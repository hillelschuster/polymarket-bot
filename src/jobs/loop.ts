// Job: continuous loop with dual-cycle architecture.
//
// FAST CYCLE (default 7 min): monitor:trades → score:trades → update-pnl → review
//   Runs frequently to catch signals while fresh (signal age was #1 rejection reason).
//
// SLOW CYCLE (default 30 min): scan:leaderboard → scan:wallets → rules → reports
//   Refreshes wallet intelligence without blocking trade detection.
//
// The fast cycle ALWAYS runs first on startup (immediate trade detection).
// The slow cycle runs on startup too (to populate wallet scores), then every N fast passes.
//
// Env overrides:
//   FAST_INTERVAL_MS  (default 420000 = 7 min, start-to-start target)
//   SLOW_EVERY_N_PASSES (default 4 = every 4th fast pass ≈ 28 min)
//   LOOP_MAX_PASSES (default Infinity)

import { runFastPath, runSlowPath } from "./runAll.js";
import { logStartupContext } from "../lib/runtime.js";
import { acquireProcessLock } from "../lib/processLock.js";

// Safety net: never let an unhandled rejection/exception kill the overnight loop.
process.on("uncaughtException", (e) => console.error("uncaughtException:", (e as Error).message));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", (e as Error)?.message ?? String(e)));

const FAST_INTERVAL_MS = Number(process.env.FAST_INTERVAL_MS ?? 7 * 60 * 1000);
// Floor so a pass that overruns the target still gets a short breather before the next.
const MIN_SLEEP_MS = 60_000;
const SLOW_EVERY_N_PASSES = Number(process.env.SLOW_EVERY_N_PASSES ?? 4);
const MAX_PASSES = process.env.LOOP_MAX_PASSES ? Number(process.env.LOOP_MAX_PASSES) : Infinity;

async function main() {
  logStartupContext();
  let pass = 0;

  // Run slow path once on startup to ensure wallet scores are populated
  console.log(`\n########## STARTUP: SLOW PATH (wallet refresh) @ ${new Date().toISOString()} ##########`);
  try {
    await runSlowPath();
  } catch (e) {
    console.error("startup slow path error:", (e as Error).message);
  }

  while (pass < MAX_PASSES) {
    pass++;
    const start = Date.now();
    console.log(`\n########## FAST PASS ${pass} @ ${new Date().toISOString()} ##########`);

    try {
      await runFastPath();
    } catch (e) {
      console.error("fast path error:", (e as Error).message);
    }

    // Run slow path every N passes
    if (pass % SLOW_EVERY_N_PASSES === 0) {
      console.log(`\n--- SLOW PATH (wallet refresh, pass ${pass}) ---`);
      try {
        await runSlowPath();
      } catch (e) {
        console.error("slow path error:", (e as Error).message);
      }
    }

    // Start-to-start cadence: sleep only the remainder of the target interval.
    // Previously the full interval was slept AFTER every pass (pass + 7 min),
    // which pushed the effective cycle past the 20-min sports signal window.
    const elapsedMs = Date.now() - start;
    const sleepMs = Math.max(MIN_SLEEP_MS, FAST_INTERVAL_MS - elapsedMs);
    console.log(`pass ${pass} took ${(elapsedMs / 1000).toFixed(0)}s; sleeping ${(sleepMs / 1000).toFixed(0)}s`);
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  console.log("loop finished");
}

if (require.main === module) {
  try {
    acquireProcessLock();
    main().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
