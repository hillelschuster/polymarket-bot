// Job: continuous overnight loop. Runs the full pipeline on an interval.
// Fault-isolated inside runPipeline, so one bad API call won't kill the loop.
// ponytail: interval via LOOP_INTERVAL_MS (default 15 min); LOOP_MAX_PASSES caps runs.
import { runPipeline } from "./runAll.js";

// Safety net: never let an unhandled rejection/exception kill the overnight loop.
// The wrapper (run_loop.sh) restarts the process; we also log + swallow here so a
// single bad API call can't terminate the whole run.
process.on("uncaughtException", (e) => console.error("uncaughtException:", (e as Error).message));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", (e as Error)?.message ?? String(e)));

const INTERVAL_MS = Number(process.env.LOOP_INTERVAL_MS ?? 15 * 60 * 1000);
const MAX_PASSES = process.env.LOOP_MAX_PASSES ? Number(process.env.LOOP_MAX_PASSES) : Infinity;

async function main() {
  let pass = 0;
  while (pass < MAX_PASSES) {
    pass++;
    const start = Date.now();
    console.log(`\n########## LOOP PASS ${pass} @ ${new Date().toISOString()} ##########`);
    try {
      await runPipeline();
    } catch (e) {
      console.error("pipeline error:", (e as Error).message);
    }
    const elapsed = (Date.now() - start) / 1000;
    console.log(`pass ${pass} took ${elapsed.toFixed(0)}s; sleeping ${(INTERVAL_MS / 1000).toFixed(0)}s`);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.log("loop finished");
}

if (require.main === module) main().catch(console.error);
