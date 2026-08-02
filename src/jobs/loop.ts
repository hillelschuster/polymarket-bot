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
//   FAST_INTERVAL_MS  (default 420000 = 7 min)
//   SLOW_EVERY_N_PASSES (default 4 = every 4th fast pass ≈ 28 min)
//   LOOP_MAX_PASSES (default Infinity)

import { runFastPath, runSlowPath } from "./runAll.js";
import { logStartupContext } from "../lib/runtime.js";

// Safety net: never let an unhandled rejection/exception kill the overnight loop.
process.on("uncaughtException", (e) => console.error("uncaughtException:", (e as Error).message));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", (e as Error)?.message ?? String(e)));

const FAST_INTERVAL_MS = Number(process.env.FAST_INTERVAL_MS ?? 7 * 60 * 1000);
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

    const elapsed = (Date.now() - start) / 1000;
    console.log(`pass ${pass} took ${elapsed.toFixed(0)}s; sleeping ${(FAST_INTERVAL_MS / 1000).toFixed(0)}s`);
    await new Promise((r) => setTimeout(r, FAST_INTERVAL_MS));
  }
  console.log("loop finished");
}

if (require.main === module) main().catch(console.error);
