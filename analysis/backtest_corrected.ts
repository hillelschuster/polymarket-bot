/**
 * CORRECTED backtest — fixes the PnL formula bug in src/jobs/backtest.ts.
 *
 * BUG: original computes  pnlFor(side, entry, yesWon) × SIZE
 *      which gives per-share PnL × dollars = wrong units.
 * FIX: pnlFor(side, entry, yesWon) × (SIZE / entry)
 *      because shares = cash / entry, and dollar PnL = shares × per-share PnL.
 *
 * Also adds: resolved-vs-stoploss split, category breakdown, entry-bucket breakdown.
 *
 * Run: npx tsx analysis/backtest_corrected.ts
 * READ-ONLY: no modifications to bot or database.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// --- Per-share PnL (same as original, this part was correct) ---
function pnlPerShare(side: string | null, entry: number, yesWon: boolean): number {
  const isBuy = (side ?? "BUY").toUpperCase() === "BUY";
  return isBuy ? (yesWon ? 1 : 0) - entry : entry - (yesWon ? 1 : 0);
}

// --- CORRECT dollar PnL: shares × per-share PnL ---
function dollarPnl(side: string | null, entry: number, yesWon: boolean, cash: number): number {
  if (entry <= 0 || entry >= 1) return 0;
  const shares = cash / entry;
  return shares * pnlPerShare(side, entry, yesWon);
}

// --- Category inference (same as analyze.ts) ---
function inferCategory(slug: string | null): string {
  if (!slug) return "unknown";
  const s = slug.toLowerCase();
  const sports = ["nba", "mlb", "nhl", "nfl", "soccer", "football", "tennis", "ufc", "golf", "cricket", "rugby", "boxing", "f1", "nascar", "wnba", "mls", "epl", "la-liga", "bundesliga", "serie-a", "ligue-1", "champions-league", "world-cup", "super-bowl", "world-series", "stanley-cup", "march-madness", "ncaa", "college", "wta", "atp"];
  const politics = ["president", "election", "senate", "congress", "trump", "biden", "harris", "governor", "mayor", "primary", "nominee", "impeach", "supreme-court", "scotus", "fed-chair", "tariff", "government", "shutdown", "bill", "act", "law", "policy", "vote", "ballot", "campaign", "political", "democrat", "republican", "gop", "parliament", "brexit", "geopolit", "netanyahu", "putin", "zelensky", "war", "ceasefire"];
  const crypto = ["bitcoin", "btc", "ethereum", "eth", "crypto", "solana", "sol", "dogecoin", "doge", "xrp", "token", "defi", "blockchain", "binance", "coinbase"];
  const macro = ["cpi", "inflation", "gdp", "fed", "rate-cut", "interest-rate", "unemployment", "jobs-report", "nonfarm", "fomc", "treasury", "recession"];
  if (sports.some((k) => s.includes(k))) return "sports";
  if (politics.some((k) => s.includes(k))) return "politics";
  if (crypto.some((k) => s.includes(k))) return "crypto";
  if (macro.some((k) => s.includes(k))) return "macro";
  return "other";
}

interface Row {
  slug: string;
  category: string;
  side: string;
  entry: number;
  cash: number;
  yesWon: boolean;
  pnlOld: number;   // buggy formula
  pnlNew: number;   // corrected formula
  win: boolean;
  status: string;    // resolved | closed (stop-loss)
  day: string;
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${(100 * n / d).toFixed(1)}%` : "n/a";
}

function usd(n: number): string {
  return `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
}

function summarize(label: string, rows: Row[]): void {
  if (!rows.length) { console.log(`${label.padEnd(24)} n=   0`); return; }
  const n = rows.length;
  const wins = rows.filter((r) => r.win).length;
  const pnl = rows.reduce((a, r) => a + r.pnlNew, 0);
  const cash = rows.reduce((a, r) => a + r.cash, 0);
  const roi = cash > 0 ? pnl / cash : 0;
  console.log(`${label.padEnd(24)} n=${String(n).padStart(4)}  win=${String(Math.round((wins / n) * 100)).padStart(3)}%  pnl=${usd(pnl).padStart(10)}  roi=${pct(pnl, cash).padStart(8)}  avgEntry=${(rows.reduce((a, r) => a + r.entry, 0) / n).toFixed(3)}`);
}

async function main() {
  const SIZE = 10; // hypothetical $10/position

  // Fetch all paper trades with their decision journal + observed trade
  const trades = await prisma.paperTrade.findMany({
    include: { decisionJournal: { include: { observedTrade: true } } },
    orderBy: { openedAt: "asc" },
  });

  const rows: Row[] = [];
  for (const t of trades) {
    if (t.status === "open") continue; // only completed trades
    const entry = t.entryPrice ?? 0.5;
    const cash = t.simulatedPositionSize ?? SIZE;
    if (entry <= 0 || entry >= 1) continue;

    // Determine outcome from DB realizedPnl (authoritative)
    const won = (t.realizedPnl ?? 0) > 0;
    const yesWon = won; // For BUY trades, win = YES resolved to 1

    const pnlNew = dollarPnl(t.side, entry, yesWon, cash);
    const pnlOld = pnlPerShare(t.side, entry, yesWon) * cash; // buggy: × cash instead of × (cash/entry)

    rows.push({
      slug: t.slug ?? "",
      category: inferCategory(t.slug),
      side: t.side ?? "BUY",
      entry,
      cash,
      yesWon,
      pnlOld,
      pnlNew,
      win: won,
      status: t.status,
      day: t.openedAt.toISOString().slice(0, 10),
    });
  }

  const resolved = rows.filter((r) => r.status === "resolved");
  const stopLossed = rows.filter((r) => r.status === "closed");

  console.log(`\n=== CORRECTED BACKTEST — ${rows.length} completed trades ===\n`);

  // --- Formula comparison ---
  const totalOld = rows.reduce((a, r) => a + r.pnlOld, 0);
  const totalNew = rows.reduce((a, r) => a + r.pnlNew, 0);
  console.log(`PnL formula comparison:`);
  console.log(`  OLD (buggy):   ${usd(totalOld)}  (per-share × cash)`);
  console.log(`  NEW (correct): ${usd(totalNew)}  (shares × per-share, where shares = cash/entry)`);
  console.log(`  Difference:    ${usd(totalNew - totalOld)}  (old understates by ${(100 * (1 - totalOld / totalNew)).toFixed(1)}%)`);

  // --- The critical split ---
  console.log(`\n=== RESOLVED vs STOP-LOSS ===`);
  summarize("Hold-to-resolution", resolved);
  summarize("Stop-loss exits", stopLossed);
  summarize("ALL completed", rows);

  // --- By category ---
  console.log(`\n=== BY CATEGORY (resolved only) ===`);
  const categories = [...new Set(resolved.map((r) => r.category))].sort();
  for (const c of categories) {
    summarize(c, resolved.filter((r) => r.category === c));
  }

  // --- By entry bucket (resolved only) ---
  console.log(`\n=== BY ENTRY BUCKET (resolved only) ===`);
  const buckets = [
    { label: "<0.55", test: (e: number) => e > 0 && e < 0.55 },
    { label: "0.55-0.65", test: (e: number) => e >= 0.55 && e < 0.65 },
    { label: "0.65-0.70", test: (e: number) => e >= 0.65 && e < 0.70 },
    { label: "0.70-0.75", test: (e: number) => e >= 0.70 && e < 0.75 },
    { label: "0.75-0.80", test: (e: number) => e >= 0.75 && e < 0.80 },
    { label: ">=0.80", test: (e: number) => e >= 0.80 },
  ];
  for (const b of buckets) {
    const group = resolved.filter((r) => b.test(r.entry));
    if (group.length > 0) summarize(b.label, group);
  }

  // --- By day ---
  console.log(`\n=== BY DAY (all completed) ===`);
  const days = [...new Set(rows.map((r) => r.day))].sort();
  for (const d of days) {
    summarize(d, rows.filter((r) => r.day === d));
  }

  // --- What-if: remove stop-losses ---
  console.log(`\n=== WHAT-IF: NO STOP-LOSS ===`);
  console.log(`If the ${stopLossed.length} stop-lossed trades had been held to resolution`);
  console.log(`(assuming the same ${pct(resolved.filter(r=>r.win).length, resolved.length)} hold-to-res WR applies):`);
  const slCash = stopLossed.reduce((a, r) => a + r.cash, 0);
  const avgEntry = resolved.length ? resolved.reduce((a, r) => a + r.entry, 0) / resolved.length : 0.7;
  const wr = resolved.length ? resolved.filter(r => r.win).length / resolved.length : 0;
  const expectedSlWins = Math.round(stopLossed.length * wr);
  const expectedSlLosses = stopLossed.length - expectedSlWins;
  const avgWinPnl = resolved.filter(r => r.win).length
    ? resolved.filter(r => r.win).reduce((a, r) => a + r.pnlNew, 0) / resolved.filter(r => r.win).length
    : 0;
  const avgLossPnl = resolved.filter(r => !r.win).length
    ? resolved.filter(r => !r.win).reduce((a, r) => a + r.pnlNew, 0) / resolved.filter(r => !r.win).length
    : 0;
  const expectedSlPnl = expectedSlWins * avgWinPnl + expectedSlLosses * avgLossPnl;
  console.log(`  Expected: ~${expectedSlWins}W / ~${expectedSlLosses}L → ~${usd(expectedSlPnl)} PnL`);
  console.log(`  Actual stop-loss PnL: ${usd(stopLossed.reduce((a, r) => a + r.pnlNew, 0))}`);
  console.log(`  Estimated cost of stop-loss: ${usd(stopLossed.reduce((a, r) => a + r.pnlNew, 0) - expectedSlPnl)}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
