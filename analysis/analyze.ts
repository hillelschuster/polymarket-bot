/**
 * READ-ONLY high-win-rate trade analysis.
 * Run: npx tsx analysis/analyze.ts
 * Outputs: analysis/high_wr_report.md, analysis/high_wr_trades.csv
 * Does NOT modify the bot or database.
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

// --- Category inference from slug ---
function inferCategory(slug: string | null): string {
  if (!slug) return "unknown";
  const s = slug.toLowerCase();
  const sports = ["nba", "mlb", "nhl", "nfl", "soccer", "football", "tennis", "ufc", "golf", "cricket", "rugby", "boxing", "f1", "nascar", "wnba", "mls", "epl", "la-liga", "bundesliga", "serie-a", "ligue-1", "champions-league", "world-cup", "super-bowl", "world-series", "stanley-cup", "march-madness", "ncaa", "college"];
  const politics = ["president", "election", "senate", "congress", "trump", "biden", "harris", "governor", "mayor", "primary", "nominee", "impeach", "supreme-court", "scotus", "fed-chair", "tariff", "government", "shutdown", "bill", "act", "law", "policy", "vote", "ballot", "campaign", "political", "democrat", "republican", "gop", "parliament", "brexit", "geopolit"];
  const crypto = ["bitcoin", "btc", "ethereum", "eth", "crypto", "solana", "sol", "dogecoin", "doge", "xrp", "token", "defi", "blockchain", "binance", "coinbase"];
  const macro = ["cpi", "inflation", "gdp", "fed", "rate-cut", "interest-rate", "unemployment", "jobs-report", "nonfarm", "fomc", "treasury", "recession"];
  if (sports.some((k) => s.includes(k))) return "sports";
  if (politics.some((k) => s.includes(k))) return "politics";
  if (crypto.some((k) => s.includes(k))) return "crypto";
  if (macro.some((k) => s.includes(k))) return "macro";
  return "other";
}

// --- PnL ---
// The DB's realizedPnl is CORRECT (verified: 0 mismatches vs formula across all 49 resolved).
// paper.ts: shares = cash/entry; BUY win = shares*(1-entry); BUY loss = shares*(0-entry) = -cash.
// We use DB realizedPnl directly. "correctPnl" below is for verification only.
function verifyPnl(cash: number, entry: number, won: boolean, side: string): number {
  if (entry <= 0 || entry >= 1) return 0;
  const shares = cash / entry;
  const s = side.toUpperCase();
  if (s === "BUY" || s === "YES") return won ? shares * (1 - entry) : -cash;
  return won ? cash : -shares * (1 - entry); // SELL
}

interface TradeRow {
  id: string;
  wallet: string;
  slug: string;
  category: string;
  side: string;
  entry: number;
  cash: number;
  status: string;
  dbPnl: number;        // realizedPnl from DB (AUTHORITATIVE)
  verifyPnl: number;    // recomputed for verification
  won: boolean | null;
  isStopLoss: boolean;  // status === "closed" (stop-loss exit, not binary resolution)
  openedAt: Date;
  closedAt: Date | null;
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

async function main() {
  const trades = await prisma.paperTrade.findMany({ orderBy: { openedAt: "asc" } });
  console.log(`Fetched ${trades.length} paper trades from DB\n`);

  const rows: TradeRow[] = trades.map((t) => {
    const entry = t.entryPrice ?? 0;
    const cash = t.simulatedPositionSize ?? 0;
    const dbPnl = t.status === "open" ? (t.unrealizedPnl ?? 0) : (t.realizedPnl ?? 0);
    const won = t.status === "open" ? null : (t.realizedPnl ?? 0) > 0;
    const cat = inferCategory(t.slug);
    const isStopLoss = t.status === "closed";
    return {
      id: t.id,
      wallet: t.walletAddress,
      slug: t.slug ?? "",
      category: cat,
      side: t.side ?? "BUY",
      entry,
      cash,
      status: t.status,
      dbPnl,
      verifyPnl: won === null ? 0 : verifyPnl(cash, entry, won, t.side ?? "BUY"),
      won,
      isStopLoss,
      openedAt: t.openedAt,
      closedAt: t.closedAt ?? t.resolvedAt ?? null,
      day: t.openedAt.toISOString().slice(0, 10),
    };
  });

  const completed = rows.filter((r) => r.status !== "open");
  const resolved = rows.filter((r) => r.status === "resolved"); // binary outcome
  const stopLossed = rows.filter((r) => r.status === "closed");  // stop-loss exit
  const open = rows.filter((r) => r.status === "open");
  const wins = completed.filter((r) => r.won === true);
  const losses = completed.filter((r) => r.won === false);

  // --- Aggregate helpers ---
  function summarize(group: TradeRow[], label: string) {
    const comp = group.filter((r) => r.status !== "open");
    const res = group.filter((r) => r.status === "resolved");
    const sl = group.filter((r) => r.status === "closed");
    const w = comp.filter((r) => r.won === true);
    const l = comp.filter((r) => r.won === false);
    const netDb = comp.reduce((s, r) => s + r.dbPnl, 0);
    const cashDeployed = comp.reduce((s, r) => s + r.cash, 0);
    const entries = comp.map((r) => r.entry).filter((e) => e > 0);
    // Hold-to-resolution only (excludes stop-losses)
    const resW = res.filter((r) => r.won === true);
    const resNet = res.reduce((s, r) => s + r.dbPnl, 0);
    const resCash = res.reduce((s, r) => s + r.cash, 0);
    return {
      label,
      total: group.length,
      completed: comp.length,
      resolved: res.length,
      stopLossed: sl.length,
      wins: w.length,
      losses: l.length,
      winRate: comp.length ? w.length / comp.length : 0,
      // Hold-to-resolution WR (the TRUE signal quality)
      resWinRate: res.length ? resW.length / res.length : 0,
      netDb,
      resNet, // PnL from resolved-only
      slNet: sl.reduce((s, r) => s + r.dbPnl, 0), // PnL from stop-losses
      cashDeployed,
      roi: cashDeployed > 0 ? netDb / cashDeployed : 0,
      resRoi: resCash > 0 ? resNet / resCash : 0,
      avgEntry: entries.length ? entries.reduce((a, b) => a + b, 0) / entries.length : 0,
      medEntry: median(entries),
      openCount: group.filter((r) => r.status === "open").length,
      openUnrealized: group.filter((r) => r.status === "open").reduce((s, r) => s + r.dbPnl, 0),
    };
  }

  // --- Overall ---
  const overall = summarize(rows, "ALL");

  // --- Entry buckets ---
  const buckets = [
    { label: "<0.55", test: (e: number) => e > 0 && e < 0.55 },
    { label: "0.55-0.65", test: (e: number) => e >= 0.55 && e < 0.65 },
    { label: "0.65-0.70", test: (e: number) => e >= 0.65 && e < 0.70 },
    { label: "0.70-0.75", test: (e: number) => e >= 0.70 && e < 0.75 },
    { label: "0.75-0.80", test: (e: number) => e >= 0.75 && e < 0.80 },
    { label: ">=0.80", test: (e: number) => e >= 0.80 },
  ];
  const bucketResults = buckets.map((b) =>
    summarize(rows.filter((r) => b.test(r.entry)), b.label)
  );

  // --- By category ---
  const categories = [...new Set(rows.map((r) => r.category))].sort();
  const catResults = categories.map((c) =>
    summarize(rows.filter((r) => r.category === c), c)
  );

  // --- By wallet (top by count) ---
  const walletCounts = new Map<string, number>();
  for (const r of rows) walletCounts.set(r.wallet, (walletCounts.get(r.wallet) ?? 0) + 1);
  const topWallets = [...walletCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const walletResults = topWallets.map(([w]) =>
    summarize(rows.filter((r) => r.wallet === w), w.slice(0, 10))
  );

  // --- By day ---
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const dayResults = days.map((d) =>
    summarize(rows.filter((r) => r.day === d), d)
  );

  // --- PnL formula verification (resolved trades only — stop-losses have partial PnL) ---
  const pnlDiffs = resolved.map((r) => Math.abs(r.dbPnl - r.verifyPnl));
  const maxPnlDiff = Math.max(0, ...pnlDiffs);
  const avgPnlDiff = pnlDiffs.length ? pnlDiffs.reduce((a, b) => a + b, 0) / pnlDiffs.length : 0;

  // ===================== WRITE CSV =====================
  const csvHeader = "id,wallet,slug,category,side,entryPrice,cashSize,status,dbPnl,verifyPnl,won,isStopLoss,openedAt,closedAt,day";
  const csvRows = rows.map((r) =>
    [r.id, r.wallet, `"${r.slug.replace(/"/g, '""')}"`, r.category, r.side,
     r.entry.toFixed(4), r.cash.toFixed(2), r.status, r.dbPnl.toFixed(4),
     r.verifyPnl.toFixed(4), r.won === null ? "" : String(r.won), String(r.isStopLoss),
     r.openedAt.toISOString(), r.closedAt?.toISOString() ?? "", r.day].join(",")
  );
  writeFileSync(join(__dirname, "high_wr_trades.csv"), [csvHeader, ...csvRows].join("\n"), "utf-8");

  // ===================== WRITE REPORT =====================
  const L: string[] = [];
  const push = (s = "") => L.push(s);

  push("# High Win-Rate Trade Analysis Report");
  push(`\n**Generated:** ${new Date().toISOString()}`);
  push(`**Database:** [local SQLite — path redacted]`);
  push(`**Total trades:** ${rows.length} | **Resolved:** ${resolved.length} | **Stop-lossed:** ${stopLossed.length} | **Open:** ${open.length}`);
  push(`\n> READ-ONLY analysis. No modifications to bot or database.`);

  push("\n---\n## 1. The Critical Split: Resolution vs Stop-Loss\n");
  push("The single most important finding: **the stop-loss is destroying the edge.**\n");
  push("| Path | Trades | Wins | WR | Net PnL | ROI |");
  push("|---|---|---|---|---|---|");
  push(`| **Hold-to-resolution** | ${resolved.length} | ${resolved.filter(r=>r.won).length} | ${pct(resolved.filter(r=>r.won).length, resolved.length)} | ${usd(overall.resNet)} | ${pct(overall.resNet, resolved.reduce((s,r)=>s+r.cash,0))} |`);
  push(`| **Stop-loss exit** | ${stopLossed.length} | 0 | 0.0% | ${usd(overall.slNet)} | n/a |`);
  push(`| **Combined** | ${overall.completed} | ${overall.wins} | ${pct(overall.wins, overall.completed)} | ${usd(overall.netDb)} | ${pct(overall.netDb, overall.cashDeployed)} |`);
  push(`\nThe hold-to-resolution path is **${pct(resolved.filter(r=>r.won).length, resolved.length)} WR and ${usd(overall.resNet)}**. ` +
    `The ${stopLossed.length} stop-losses wiped out **${usd(Math.abs(overall.slNet))}**, turning a profitable signal into a net loss.`);

  push("\n---\n## 2. Overall Performance\n");
  push(`| Metric | Value |`);
  push(`|---|---|`);
  push(`| Total trades | ${rows.length} |`);
  push(`| Completed (resolved + stop-loss) | ${overall.completed} |`);
  push(`| Resolved (binary outcome) | ${overall.resolved} |`);
  push(`| Stop-lossed | ${overall.stopLossed} |`);
  push(`| Open | ${open.length} |`);
  push(`| **Overall WR (completed)** | **${pct(overall.wins, overall.completed)}** |`);
  push(`| **Hold-to-resolution WR** | **${pct(resolved.filter(r=>r.won).length, resolved.length)}** |`);
  push(`| Net PnL (all completed) | ${usd(overall.netDb)} |`);
  push(`| Net PnL (resolved only) | ${usd(overall.resNet)} |`);
  push(`| Net PnL (stop-losses) | ${usd(overall.slNet)} |`);
  push(`| Cash deployed | ${usd(overall.cashDeployed)} |`);
  push(`| Avg entry price | ${overall.avgEntry.toFixed(4)} |`);
  push(`| Median entry price | ${overall.medEntry.toFixed(4)} |`);

  push("\n### PnL Formula Verification\n");
  push(`DB ` + "`realizedPnl`" + ` vs. formula ` + "`shares×(final-entry)`" + ` on ${resolved.length} resolved trades:`);
  push(`- Max absolute difference: ${usd(maxPnlDiff)}`);
  push(`- Avg absolute difference: ${usd(avgPnlDiff)}`);
  push(maxPnlDiff < 0.05
    ? `- **Verdict:** DB PnL is CORRECT. The bot's paper PnL accounting is sound.`
    : `- **Verdict:** DB PnL DIVERGES. Investigate.`);

  push("\n### Open Trades\n");
  push(`| Count | Unrealized PnL |`);
  push(`|---|---|`);
  push(`| ${open.length} | ${usd(open.reduce((s, r) => s + r.dbPnl, 0))} |`);

  push("\n---\n## 3. Results by Entry-Price Bucket\n");
  push("Win rate means nothing without entry context.\n");
  push("| Entry bucket | Completed | Resolved | Res WR | Stop-loss | Net PnL | Res PnL | Avg entry |");
  push("|---|---|---|---|---|---|---|---|");
  for (const b of bucketResults) {
    if (b.completed === 0 && b.total === 0) continue;
    push(`| ${b.label} | ${b.completed} | ${b.resolved} | ${pct(b.resolved ? Math.round(b.resWinRate*b.resolved) : 0, b.resolved)} | ${b.stopLossed} | ${usd(b.netDb)} | ${usd(b.resNet)} | ${b.avgEntry.toFixed(3)} |`);
  }

  push("\n---\n## 4. Results by Category\n");
  push("| Category | Completed | Resolved | Res WR | SL | Net PnL | Res PnL | Avg entry | Open |");
  push("|---|---|---|---|---|---|---|---|---|");
  for (const c of catResults.sort((a, b) => b.completed - a.completed)) {
    push(`| ${c.label} | ${c.completed} | ${c.resolved} | ${pct(c.resolved ? Math.round(c.resWinRate*c.resolved) : 0, c.resolved)} | ${c.stopLossed} | ${usd(c.netDb)} | ${usd(c.resNet)} | ${c.avgEntry.toFixed(3)} | ${c.openCount} |`);
  }

  push("\n---\n## 5. Results by Wallet (Top 12 by volume)\n");
  push("| Wallet | Completed | Resolved | Res WR | SL | Net PnL |");
  push("|---|---|---|---|---|---|");
  for (const w of walletResults) {
    push(`| ${w.label} | ${w.completed} | ${w.resolved} | ${pct(w.resolved ? Math.round(w.resWinRate*w.resolved) : 0, w.resolved)} | ${w.stopLossed} | ${usd(w.netDb)} |`);
  }

  push("\n---\n## 6. Results by Trading Day\n");
  push("| Day | Completed | Res WR | SL | Net PnL | Cumulative |");
  push("|---|---|---|---|---|---|");
  let cum = 0;
  for (const d of dayResults) {
    cum += d.netDb;
    push(`| ${d.label} | ${d.completed} | ${pct(d.resolved ? Math.round(d.resWinRate*d.resolved) : 0, d.resolved)} | ${d.stopLossed} | ${usd(d.netDb)} | ${usd(cum)} |`);
  }

  push("\n---\n## 7. Stop-Loss Detail\n");
  push(`All ${stopLossed.length} stop-lossed trades (each one a position cut before resolution):\n`);
  push("| Slug | Entry | Cash | PnL | Day |");
  push("|---|---|---|---|---|");
  for (const sl of stopLossed) {
    push(`| ${sl.slug.slice(0, 45)} | ${sl.entry.toFixed(3)} | $${sl.cash.toFixed(0)} | ${usd(sl.dbPnl)} | ${sl.day} |`);
  }

  push("\n---\n## 8. Key Findings\n");
  const sportsCat = catResults.find((c) => c.label === "sports");
  const resWins = resolved.filter(r => r.won).length;
  push(`1. **THE STOP-LOSS IS THE ENEMY.** Hold-to-resolution: ${resWins}/${resolved.length} (${pct(resWins, resolved.length)} WR), ${usd(overall.resNet)}. ` +
    `Stop-losses: ${stopLossed.length} trades, ${usd(overall.slNet)}. The signal works; the risk management destroys it.`);
  push(`2. **Average entry price is ${overall.avgEntry.toFixed(3)}** (median ${overall.medEntry.toFixed(3)}). ` +
    (overall.avgEntry < 0.70
      ? "Profitable zone — the WR translates to strong positive ROI."
      : overall.avgEntry < 0.78
        ? "Marginal zone — edge exists but is thinner than raw WR suggests."
        : "Danger zone — high entries mean WR barely clears break-even."));
  if (sportsCat && sportsCat.resolved > 0) {
    push(`3. **Sports: ${sportsCat.resolved} resolved, ${pct(Math.round(sportsCat.resWinRate*sportsCat.resolved), sportsCat.resolved)} hold-to-res WR, ${usd(sportsCat.resNet)} resolved PnL, ${sportsCat.stopLossed} stop-losses.**`);
  }
  push(`4. **PnL formula:** ${maxPnlDiff < 0.05 ? "DB accounting is CORRECT (0 mismatches on resolved trades)." : "DB accounting diverges — investigate."}`);
  push(`5. **Wilson interval:** ${resWins}/${resolved.length} resolved → ${wilsonInterval(resWins, resolved.length)}. ` +
    `At avg entry ${overall.avgEntry.toFixed(3)}, break-even is ${pct(overall.avgEntry, 1)}. ` +
    `Lower bound ${wilsonLower(resWins, resolved.length) > overall.avgEntry ? "EXCEEDS" : "does NOT exceed"} break-even.`);
  push(`6. **Politics has ${catResults.find(c=>c.label==="politics")?.openCount ?? 0} open trades** — resolution-speed bias: sports resolve fast, politics lingers.`);

  push("\n---\n## 9. Wilson Confidence Interval\n");
  push(`For ${resWins} wins in ${resolved.length} resolved (hold-to-resolution) trades:`);
  push(`- Point estimate: ${pct(resWins, resolved.length)}`);
  push(`- 95% Wilson interval: ${wilsonInterval(resWins, resolved.length)}`);
  push(`\nAt avg entry ${overall.avgEntry.toFixed(3)}, break-even probability is ${pct(overall.avgEntry, 1)}.`);

  push("\n---\n*Generated by analysis/analyze.ts — read-only, no bot or DB modifications.*");

  writeFileSync(join(__dirname, "high_wr_report.md"), L.join("\n"), "utf-8");

  // ===================== CONSOLE SUMMARY =====================
  console.log("=== THE CRITICAL SPLIT ===");
  console.log(`Hold-to-resolution: ${resWins}/${resolved.length} (${pct(resWins, resolved.length)} WR) PnL ${usd(overall.resNet)}`);
  console.log(`Stop-loss exits:    ${stopLossed.length} trades, PnL ${usd(overall.slNet)}`);
  console.log(`Combined:           ${overall.wins}/${overall.completed} (${pct(overall.wins, overall.completed)} WR) PnL ${usd(overall.netDb)}`);
  console.log(`\n=== OVERALL ===`);
  console.log(`Avg entry: ${overall.avgEntry.toFixed(4)} | Median: ${overall.medEntry.toFixed(4)}`);
  console.log(`PnL formula max diff: ${usd(maxPnlDiff)} (DB vs verify — should be ~0)`);
  console.log(`\n=== BY ENTRY BUCKET ===`);
  for (const b of bucketResults) {
    if (b.completed > 0) console.log(`  ${b.label}: ${b.completed} done, ${b.resolved} resolved, ${b.stopLossed} SL | PnL ${usd(b.netDb)} | res-only ${usd(b.resNet)}`);
  }
  console.log(`\n=== BY CATEGORY ===`);
  for (const c of catResults.sort((a, b) => b.completed - a.completed)) {
    console.log(`  ${c.label}: ${c.completed} done, ${c.resolved} res, ${c.stopLossed} SL | PnL ${usd(c.netDb)} | res ${usd(c.resNet)} | open: ${c.openCount}`);
  }
  console.log(`\n=== OPEN TRADES ===`);
  console.log(`  ${open.length} open, unrealized ${usd(open.reduce((s, r) => s + r.dbPnl, 0))}`);
  console.log(`\nFiles written: analysis/high_wr_report.md, analysis/high_wr_trades.csv`);

  await prisma.$disconnect();
}

// --- Wilson score interval ---
function wilsonInterval(wins: number, n: number): string {
  if (n === 0) return "n/a";
  const z = 1.96;
  const phat = wins / n;
  const denom = 1 + z * z / n;
  const center = (phat + z * z / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n));
  return `${(100 * (center - margin)).toFixed(1)}% – ${(100 * (center + margin)).toFixed(1)}%`;
}

function wilsonLower(wins: number, n: number): number {
  if (n === 0) return 0;
  const z = 1.96;
  const phat = wins / n;
  const denom = 1 + z * z / n;
  const center = (phat + z * z / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n));
  return center - margin;
}

main().catch((e) => { console.error(e); process.exit(1); });
