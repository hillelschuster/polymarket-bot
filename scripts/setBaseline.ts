// Set the profit-measurement baseline to now (or an ISO date arg).
// The universe diagnostic reports forward PnL from this point, giving a clean
// slate to judge the strategy after config changes. Run: npm run diag:baseline
import { writeFileSync } from "node:fs";
const when = process.argv[2] ? new Date(process.argv[2]) : new Date();
if (isNaN(when.getTime())) {
  console.error(`invalid date: ${process.argv[2]}`);
  process.exit(1);
}
writeFileSync("baseline.json", when.toISOString());
console.log(`baseline set to ${when.toISOString()}`);
