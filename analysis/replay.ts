/**
 * Before/After replay: measures the impact of the wallet-skill + sizing patch.
 *
 * BEFORE: old behavior (all trades, all statuses, wallet|side key, confidence sizing)
 * AFTER:  new behavior (wallet_copy + resolved only, wallet|segment key, segment sizing)
 *
 * Run: npx tsx analysis/replay.ts
 * READ-ONLY: no modifications to bot or database.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// --- Segment classification (mirrors scoring.ts) ---
type MarketSegment = "sports_mainline" | "sports_derivative" | "tennis" | "other";
const TENNIS = new Set(["wta", "atp", "itf", "challenger"]);
const DERIV_KW = ["spread", "total", "totals", "set", "prop", "over", "under", "handicap", "run-line", "puck-line", "point-spread"];
const SPORTS_PREFIXES = new Set(["mlb", "nba", "nfl", "nhl", "epl", "ucl", "mex", "mls", "fifa", "fifwc", "wnba", "ncaaf", "ncaab", "tennis", "golf", "ufc", "boxing", "f1", "nascar", "wta", "atp", "itf", "challenger"]);

function segmentFromSlug(slug: string | null): MarketSegment {
  if (!slug) return "other";
  const s = slug.toLowerCase();
  const prefix = s.split("-")[0];
  if (TENNIS.has(prefix)) return "tennis";
  if (SPORTS_PREFIXES.has(prefix)) {
    if (DERIV_KW.some((k) => s.includes(k))) return "sports_derivative";
    return "sports_mainline";
  }
  return "other";
}

function segmentSize(seg: MarketSegment): number {
  return seg === "sports_mainline" ? 20 : 5;
}

function pct(n: number, d: number): string { return d > 0 ? `${(100 * n / d).toFixed(1)}%` : "n/a"; }
function usd(n: number): string { return `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`; }

interface Row {
  id: string; wallet: string; slug: string; segment: MarketSegment;
  entry: number; cash: number; source: string; status: string;
  pnl: number; won: boolean | null; day: string;
}

async function main() {
  const trades = await prisma.paperTrade.findMany({ orderBy: { openedAt: "asc" } });
  const rows: Row[] = trades.map((t) => ({
    id: t.id, wallet: t.walletAddress, slug: t.slug ?? "",
    segment: segmentFromSlug(t.slug),
    entry: t.entryPrice ?? 0.5, cash: t.simulatedPositionSize ?? 10,
    source: t.source, status: t.status,
    pnl: t.status === "open" ? (t.unrealizedPnl ?? 0) : (t.realizedPnl ?? 0),
    won: t.status === "open" ? null : (t.realizedPnl ?? 0) > 0,
    day: t.openedAt.toISOString().slice(0, 10),
  }));

  const completed = rows.filter((r) => r.status !== "open");
  const resolved = rows.filter((r) => r.status === "resolved");
  const closed = rows.filter((r) => r.status === "closed");
  const open = rows.filter((r) => r.status === "open");

  console.log("=".repeat(70));
  console.log("BEFORE/AFTER REPLAY — Wallet-Skill + Sizing Patch");
  console.log("=".repeat(70));

  // ===== SECTION 1: Raw data overview =====
  console.log(`\n--- DATA OVERVIEW ---`);
  console.log(`Total trades: ${rows.length} | Resolved: ${resolved.length} | Closed (SL): ${closed.length} | Open: ${open.length}`);
  console.log(`Sources: wallet_copy=${rows.filter(r => r.source === "wallet_copy").length}, strategy=${rows.filter(r => r.source !== "wallet_copy").length}`);

  // ===== SECTION 2: BEFORE (old behavior) =====
  console.log(`\n${"=".repeat(70)}`);
  console.log("BEFORE: Old behavior (all trades, all statuses, wallet|side key)");
  console.log("=".repeat(70));
  const beforeCompleted = completed;
  const beforeWins = beforeCompleted.filter(r => r.won);
  const beforePnl = beforeCompleted.reduce((s, r) => s + r.pnl, 0);
  const beforeCash = beforeCompleted.reduce((s, r) => s + r.cash, 0);
  console.log(`Completed: ${beforeCompleted.length} | W${beforeWins.length}/L${beforeCompleted.length - beforeWins.length} | WR ${pct(beforeWins.length, beforeCompleted.length)}`);
  console.log(`Net PnL: ${usd(beforePnl)} | Cash deployed: ${usd(beforeCash)} | ROI: ${pct(beforePnl, beforeCash)}`);

  // Wallet demotion simulation (BEFORE): totalPnl from ALL trades
  const beforeWalletPnl = new Map<string, number>();
  for (const r of rows) {
    beforeWalletPnl.set(r.wallet, (beforeWalletPnl.get(r.wallet) ?? 0) + r.pnl);
  }
  const beforeDemoted = [...beforeWalletPnl.entries()].filter(([, pnl]) => pnl < -3);
  console.log(`\nWallets demoted (totalPnl < -$3): ${beforeDemoted.length}`);
  for (const [w, pnl] of beforeDemoted.sort((a, b) => a[1] - b[1]).slice(0, 5)) {
    const resCount = resolved.filter(r => r.wallet === w).length;
    const resPnl = resolved.filter(r => r.wallet === w).reduce((s, r) => s + r.pnl, 0);
    console.log(`  ${w.slice(0, 12)}: total=${usd(pnl)} BUT resolved-only=${usd(resPnl)} (${resCount} res)`);
  }

  // ===== SECTION 3: AFTER (new behavior) =====
  console.log(`\n${"=".repeat(70)}`);
  console.log("AFTER: New behavior (wallet_copy + resolved, wallet|segment, segment sizing)");
  console.log("=".repeat(70));

  // Wallet-copy resolved only
  const wcResolved = resolved.filter(r => r.source === "wallet_copy");
  const wcWins = wcResolved.filter(r => r.won);
  const wcPnl = wcResolved.reduce((s, r) => s + r.pnl, 0);
  const wcCash = wcResolved.reduce((s, r) => s + r.cash, 0);
  console.log(`Wallet-copy resolved: ${wcResolved.length} | W${wcWins.length}/L${wcResolved.length - wcWins.length} | WR ${pct(wcWins.length, wcResolved.length)}`);
  console.log(`Net PnL: ${usd(wcPnl)} | Cash deployed: ${usd(wcCash)} | ROI: ${pct(wcPnl, wcCash)}`);

  // Strategy trades separately
  const stratResolved = resolved.filter(r => r.source !== "wallet_copy");
  const stratPnl = stratResolved.reduce((s, r) => s + r.pnl, 0);
  console.log(`Strategy trades (resolved): ${stratResolved.length} | PnL: ${usd(stratPnl)}`);

  // Wallet demotion simulation (AFTER): resolved wallet-copy only
  const afterWalletPnl = new Map<string, number>();
  for (const r of wcResolved) {
    afterWalletPnl.set(r.wallet, (afterWalletPnl.get(r.wallet) ?? 0) + r.pnl);
  }
  const afterDemoted = [...afterWalletPnl.entries()].filter(([, pnl]) => pnl < -3);
  console.log(`\nWallets demoted (resolved WC PnL < -$3): ${afterDemoted.length}`);
  for (const [w, pnl] of afterDemoted.sort((a, b) => a[1] - b[1]).slice(0, 5)) {
    console.log(`  ${w.slice(0, 12)}: ${usd(pnl)}`);
  }

  // ===== SECTION 4: Segment breakdown =====
  console.log(`\n${"=".repeat(70)}`);
  console.log("SEGMENT BREAKDOWN (wallet-copy resolved only)");
  console.log("=".repeat(70));
  const segments: MarketSegment[] = ["sports_mainline", "sports_derivative", "tennis", "other"];
  console.log(`${"Segment".padEnd(20)} ${"N".padStart(4)} ${"W".padStart(4)} ${"WR".padStart(7)} ${"PnL".padStart(10)} ${"ROI".padStart(8)} ${"MktExp".padStart(7)} ${"Uplift".padStart(7)} ${"AvgEntry".padStart(9)}`);
  for (const seg of segments) {
    const g = wcResolved.filter(r => r.segment === seg);
    if (!g.length) continue;
    const w = g.filter(r => r.won).length;
    const pnl = g.reduce((s, r) => s + r.pnl, 0);
    const cash = g.reduce((s, r) => s + r.cash, 0);
    const mktExp = g.reduce((s, r) => s + r.entry, 0); // sum of entry prices = expected wins
    const uplift = w - mktExp;
    const avgEntry = g.reduce((s, r) => s + r.entry, 0) / g.length;
    console.log(`${seg.padEnd(20)} ${String(g.length).padStart(4)} ${String(w).padStart(4)} ${pct(w, g.length).padStart(7)} ${usd(pnl).padStart(10)} ${pct(pnl, cash).padStart(8)} ${mktExp.toFixed(1).padStart(7)} ${uplift >= 0 ? "+" : ""}${uplift.toFixed(1)}`.padEnd(75) + `${avgEntry.toFixed(3).padStart(9)}`);
  }

  // ===== SECTION 5: Sizing overlay replay =====
  console.log(`\n${"=".repeat(70)}`);
  console.log("SIZING OVERLAY REPLAY (in-sample: what if segment sizing was used?)");
  console.log("=".repeat(70));
  // For each resolved wallet-copy trade, compute PnL at segment size instead of actual size
  let overlayPnl = 0;
  let overlayCash = 0;
  const eventDeployed = new Map<string, number>();
  const MAX_PER_EVENT = 20;
  for (const r of wcResolved) {
    const segSize = segmentSize(r.segment);
    const slugKey = r.slug || r.id;
    const already = eventDeployed.get(slugKey) ?? 0;
    const size = Math.min(segSize, Math.max(0, MAX_PER_EVENT - already));
    eventDeployed.set(slugKey, already + size);
    if (size < 1) continue; // event cap hit
    // Recompute PnL at the new size
    const shares = size / r.entry;
    const pnl = r.won ? shares * (1 - r.entry) : -size;
    overlayPnl += pnl;
    overlayCash += size;
  }
  console.log(`Overlay PnL: ${usd(overlayPnl)} | Deployed: ${usd(overlayCash)} | ROI: ${pct(overlayPnl, overlayCash)}`);
  console.log(`Actual PnL:  ${usd(wcPnl)} | Deployed: ${usd(wcCash)} | ROI: ${pct(wcPnl, wcCash)}`);
  console.log(`Capital efficiency gain: ${usd(overlayPnl - wcPnl)} more PnL on ${usd(overlayCash - wcCash)} ${overlayCash < wcCash ? "LESS" : "more"} capital`);

  // ===== SECTION 6: Unique-event results =====
  console.log(`\n${"=".repeat(70)}`);
  console.log("UNIQUE-EVENT RESULTS (deduplicated by slug)");
  console.log("=".repeat(70));
  const bySlug = new Map<string, Row[]>();
  for (const r of wcResolved) {
    const key = r.slug || r.id;
    const arr = bySlug.get(key) ?? [];
    arr.push(r);
    bySlug.set(key, arr);
  }
  let eventWins = 0, eventLosses = 0;
  for (const [, group] of bySlug) {
    // An event is a win if ANY trade in it won
    if (group.some(r => r.won)) eventWins++;
    else eventLosses++;
  }
  console.log(`Unique events: ${bySlug.size} | Won: ${eventWins} | Lost: ${eventLosses} | Event WR: ${pct(eventWins, bySlug.size)}`);

  // ===== SECTION 7: Wallets rescued by the fix =====
  console.log(`\n${"=".repeat(70)}`);
  console.log("WALLETS RESCUED (demoted BEFORE, not demoted AFTER)");
  console.log("=".repeat(70));
  const rescued = beforeDemoted.filter(([w]) => !afterDemoted.some(([w2]) => w2 === w));
  for (const [w] of rescued) {
    const resPnl = afterWalletPnl.get(w) ?? 0;
    const resCount = wcResolved.filter(r => r.wallet === w).length;
    const resWins = wcResolved.filter(r => r.wallet === w && r.won).length;
    console.log(`  ${w.slice(0, 14)}: before=${usd(beforeWalletPnl.get(w) ?? 0)} → after=${usd(resPnl)} (${resWins}/${resCount} resolved WC)`);
  }
  if (!rescued.length) console.log("  (none — no wallets changed demotion status)");

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
