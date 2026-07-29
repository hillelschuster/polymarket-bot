// Universe diagnostic — read-only truth report on wallet intelligence + copy performance.
// Run: npm run diag:universe   (uses DATABASE_URL from .env)
//
// Answers, with zero overhead:
//   1. How big/clean is the wallet universe? (tracked / enriched-fresh / unknown-category)
//   2. Which wallets are we actually profiting from when we copy them?
//   3. Which categories carry the real edge?
//   4. Is our scoring aligned with reality? (quality score vs realized copy PnL)
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
const prisma = new PrismaClient();

const FRESH_MS = 2 * 60 * 60 * 1000; // enriched within 2h counts as "fresh"

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

interface Agg {
  resolved: number; wins: number; realized: number;
  closed: number; unrealized: number; open: number; cost: number;
}
const newAgg = (): Agg => ({ resolved: 0, wins: 0, realized: 0, closed: 0, unrealized: 0, open: 0, cost: 0 });

async function main() {
  const wallets = await prisma.walletProfile.findMany();
  const trades = await prisma.paperTrade.findMany({
    include: { decisionJournal: { include: { observedTrade: true } } },
  });

  // ---- 1. UNIVERSE ----
  const byStatus: Record<string, number> = {};
  for (const w of wallets) byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
  const fresh = wallets.filter((w) => w.lastScannedAt && Date.now() - w.lastScannedAt.getTime() < FRESH_MS).length;
  const everEnriched = wallets.filter((w) => (w.resolvedTradeCount30d ?? 0) > 0 || (w.tradeCount30d ?? 0) > 0).length;
  const unknownCat = wallets.filter((w) => !w.bestCategory).length;
  const trackNoCat = wallets.filter((w) => w.status === "track" && !w.bestCategory).length;

  console.log("========== WALLET UNIVERSE ==========");
  console.log(`total profiles:      ${wallets.length}`);
  console.log(`by status:           ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`enriched ever:       ${everEnriched}`);
  console.log(`enriched fresh(<2h): ${fresh}`);
  console.log(`unknown category:    ${unknownCat}  (tracked-but-uncategorized: ${trackNoCat})`);

  // ---- HEADLINE: is the strategy making money? ----
  const allRealized = trades.reduce((s, t) => s + (t.status !== "open" ? (t.realizedPnl ?? 0) : 0), 0);
  const allUnreal = trades.reduce((s, t) => s + (t.status === "open" ? (t.unrealizedPnl ?? 0) : 0), 0);
  let baseline: Date | null = null;
  try { baseline = new Date(readFileSync("baseline.json", "utf8").trim()); } catch { /* no baseline set */ }
  console.log("\n========== PROFIT (the number that matters) ==========");
  console.log(`all-time net realized: ${money(allRealized)}   unrealized(open): ${money(allUnreal)}   true total: ${money(allRealized + allUnreal)}`);
  if (baseline && !isNaN(baseline.getTime())) {
    const fwd = trades.filter((t) => t.openedAt >= baseline!);
    const fReal = fwd.reduce((s, t) => s + (t.status !== "open" ? (t.realizedPnl ?? 0) : 0), 0);
    const fUnreal = fwd.reduce((s, t) => s + (t.status === "open" ? (t.unrealizedPnl ?? 0) : 0), 0);
    const fResolved = fwd.filter((t) => t.status === "resolved");
    const fWins = fResolved.filter((t) => (t.realizedPnl ?? 0) > 0).length;
    console.log(`since baseline ${baseline.toISOString().slice(0, 10)}: realized ${money(fReal)} | unreal ${money(fUnreal)} | ${fWins}/${fResolved.length} wins | ${fwd.length} trades`);
  } else {
    console.log(`no baseline set — run: npm run diag:baseline`);
  }

  // ---- 2. PER-WALLET COPY PERFORMANCE ----
  const scoreOf = new Map(wallets.map((w) => [w.address, w]));
  const byWallet = new Map<string, Agg>();
  const byCat = new Map<string, Agg>();
  for (const t of trades) {
    const w = byWallet.get(t.walletAddress) ?? newAgg();
    if (t.status === "resolved") { w.resolved++; w.realized += t.realizedPnl ?? 0; if ((t.realizedPnl ?? 0) > 0) w.wins++; }
    else if (t.status === "closed") { w.closed++; w.realized += t.realizedPnl ?? 0; }
    else { w.open++; w.unrealized += t.unrealizedPnl ?? 0; }
    w.cost += t.simulatedPositionSize ?? 0;
    byWallet.set(t.walletAddress, w);

    // ObservedTrade.marketCategory is null at ingestion (known gap), so fall back to
    // the wallet's enriched bestCategory as a proxy for category-level attribution.
    const cat = t.decisionJournal?.observedTrade?.marketCategory
      ?? scoreOf.get(t.walletAddress)?.bestCategory
      ?? "unknown";
    const c = byCat.get(cat) ?? newAgg();
    if (t.status === "resolved") { c.resolved++; c.realized += t.realizedPnl ?? 0; if ((t.realizedPnl ?? 0) > 0) c.wins++; }
    else if (t.status === "closed") { c.closed++; c.realized += t.realizedPnl ?? 0; }
    else { c.open++; c.unrealized += t.unrealizedPnl ?? 0; }
    c.cost += t.simulatedPositionSize ?? 0;
    byCat.set(cat, c);
  }

  const rows = [...byWallet.entries()]
    .map(([addr, a]) => ({ addr, a, w: scoreOf.get(addr) }))
    .sort((x, y) => y.a.realized - x.a.realized);

  console.log("\n========== COPY PERFORMANCE BY WALLET (sorted by realized) ==========");
  console.log("wallet            score rank status  cat            res  W  realized  open  unreal");
  for (const { addr, a, w } of rows.slice(0, 20)) {
    console.log(
      `${short(addr).padEnd(13)} ${String(Math.round(w?.globalScore ?? 0)).padStart(5)} ${String(w?.sourceRank ?? "-").padStart(4)} ${(w?.status ?? "?").padEnd(6)} ${(w?.bestCategory ?? "-").slice(0, 12).padEnd(12)} ${String(a.resolved).padStart(3)} ${String(a.wins).padStart(2)} ${money(a.realized).padStart(9)} ${String(a.open).padStart(4)} ${money(a.unrealized).padStart(8)}`,
    );
  }

  // ---- 3. BY CATEGORY ----
  const catRows = [...byCat.entries()].sort((x, y) => y[1].realized - x[1].realized);
  console.log("\n========== COPY PERFORMANCE BY CATEGORY ==========");
  console.log("category         res  W   realized  open  unreal   cost");
  for (const [cat, c] of catRows) {
    console.log(
      `${cat.slice(0, 15).padEnd(15)} ${String(c.resolved).padStart(3)} ${String(c.wins).padStart(2)} ${money(c.realized).padStart(9)} ${String(c.open).padStart(4)} ${money(c.unrealized).padStart(8)} ${money(c.cost).padStart(8)}`,
    );
  }

  // ---- 4. ALIGNMENT: does our score predict copy profit? ----
  const copied = rows.filter((r) => r.a.resolved + r.a.closed >= 2);
  const profitable = copied.filter((r) => r.a.realized > 0);
  const avgScoreProfit = profitable.length ? profitable.reduce((s, r) => s + (r.w?.globalScore ?? 0), 0) / profitable.length : 0;
  const losers = copied.filter((r) => r.a.realized <= 0);
  const avgScoreLose = losers.length ? losers.reduce((s, r) => s + (r.w?.globalScore ?? 0), 0) / losers.length : 0;
  console.log("\n========== SCORE ALIGNMENT ==========");
  console.log(`wallets copied >=2x:  ${copied.length}`);
  console.log(`avg score of winners: ${avgScoreProfit.toFixed(1)}  (n=${profitable.length})`);
  console.log(`avg score of losers:  ${avgScoreLose.toFixed(1)}  (n=${losers.length})`);
  console.log(avgScoreProfit > avgScoreLose
    ? "-> score discriminates (higher score -> more profit). Trust it more."
    : "-> score does NOT predict copy profit. Re-weight scoring toward realized copy PnL.");

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
