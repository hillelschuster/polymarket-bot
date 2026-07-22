/**
 * LANE B — Independent Shadow Loop
 * 
 * Runs the Lane B resolution-lag scanner every 3 minutes.
 * Completely independent from the main wallet-copy pipeline.
 * Stores data in data/laneb_shadow.json only.
 * 
 * Usage: npx tsx src/research/laneBLoop.ts
 */
import { runLaneBScan } from "./laneBShadow.js";

const INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

process.on("uncaughtException", (e) => console.error("Lane B uncaughtException:", (e as Error).message));
process.on("unhandledRejection", (e) => console.error("Lane B unhandledRejection:", (e as Error)?.message ?? String(e)));

async function main() {
  console.log("=== LANE B: Resolution-Lag Shadow Logger ===");
  console.log(`Interval: ${INTERVAL_MS / 1000}s | Storage: data/laneb_shadow.json`);
  console.log("Completely independent from main pipeline.\n");

  let pass = 0;
  while (true) {
    pass++;
    console.log(`\n--- Lane B pass ${pass} @ ${new Date().toISOString()} ---`);
    try {
      await runLaneBScan();
    } catch (e) {
      console.error("Lane B scan error:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch(console.error);
