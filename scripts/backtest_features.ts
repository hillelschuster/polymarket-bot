import { PrismaClient } from "@prisma/client";
import { scoreTradeByMarket, scoreTrade, DEFAULT_RULES } from "./src/lib/scoring";

const prisma = new PrismaClient();

type Row = {
  id: string;
  side: string;
  entryPrice: number;
  finalPrice: number;
  size: number;
  pnl: number;
  win: boolean;
  favoritePrice: number; // price of the outcome we BET (YES for BUY, NO for SELL)
  liquidity: number;
  spread: number;
  daysToResolution: number;
  category: string;
  walletGlobal: number;
  walletSideOthersAvgPnl: number; // out-of-sample: avg pnl of OTHER resolved (wallet,side) copies
  walletSideOthersN: number;
  eqScore: number; // current equation score (with data-aligned fl term)
};

function q(rows: Row[], key: keyof Row, label: string) {
  const vals = rows.map((r) => r[key] as number).filter((v) => typeof v === "number" && !isNaN(v));
  if (vals.length < 8) {
    console.log(`\n## ${label}: <8 samples, skip`);
    return;
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q2 = sorted[Math.floor(sorted.length * 0.5)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const buckets: [number, number][] = [
    [-Infinity, q1],
    [q1, q2],
    [q2, q3],
    [q3, Infinity],
  ];
  console.log(`\n## ${label}  (n=${vals.length}, range ${Math.min(...vals).toFixed(2)}..${Math.max(...vals).toFixed(2)})`);
  let prevHi = -Infinity;
  for (const [lo, hi] of buckets) {
    const inB = rows.filter((r) => {
      const v = r[key] as number;
      return v >= lo && v < hi;
    });
    const n = inB.length;
    const pnl = inB.reduce((s, r) => s + r.pnl, 0);
    const wins = inB.filter((r) => r.win).length;
    const wr = n ? ((wins / n) * 100).toFixed(0) : "0";
    const tag = `${prevHi === -Infinity ? "Q1(low)" : lo === q3 ? "Q4(hi)" : ""}`;
    console.log(`  ${tag.padEnd(8)} [${lo === -Infinity ? "-inf" : lo.toFixed(2)},${hi === Infinity ? "inf" : hi.toFixed(2)}) n=${String(n).padEnd(3)} win=${wr.padStart(3)}%  pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
    prevHi = hi;
  }
}

async function main() {
  const pts = await prisma.paperTrade.findMany({
    where: { status: "resolved" },
    include: { decisionJournal: { include: { observedTrade: { include: { wallet: true } } } } },
  });
  console.log(`resolved paper trades: ${pts.length}`);

  // precompute per-(wallet,side) resolved pnls for out-of-sample wallet track record
  const bySide = new Map<string, number[]>();
  for (const pt of pts) {
    const k = `${pt.walletAddress}|${pt.side}`;
    if (!bySide.has(k)) bySide.set(k, []);
    const pnl = pt.realizedPnl ?? 0;
    bySide.get(k)!.push(pnl);
  }

  const rows: Row[] = [];
  for (const pt of pts) {
    const ot = pt.decisionJournal?.observedTrade;
    if (!ot) continue;
    const side = pt.side ?? "BUY";
    const entry = pt.entryPrice ?? 0;
    const final = pt.currentPrice ?? 0;
    const size = pt.simulatedPositionSize ?? 5;
    const pnl = side === "BUY" ? (final - entry) * size : (entry - final) * size;
    const win = pnl > 0;
    const favoritePrice = side === "BUY" ? entry : 1 - entry;

    // snapshot near entry
    let liq = ot.marketLiquidity ?? 0;
    let spr = ot.marketSpread ?? 0;
    let dtr = 30;
    let cat = ot.marketCategory ?? "?";
    if (pt.slug) {
      const snap = await prisma.marketSnapshot.findFirst({
        where: { slug: pt.slug, collectedAt: { lte: pt.openedAt ?? new Date() } },
        orderBy: { collectedAt: "desc" },
      });
      if (snap) {
        liq = snap.liquidity ?? liq;
        spr = snap.spread ?? spr;
        dtr = snap.timeToResolution ?? dtr;
        cat = snap.category ?? cat;
      }
    }

    // out-of-sample wallet-side track record
    const k = `${pt.walletAddress}|${pt.side}`;
    const others = (bySide.get(k) ?? []).filter((_, i) => bySide.get(k)![i] !== pnl);
    const wsoAvg = others.length ? others.reduce((s, v) => s + v, 0) / others.length : NaN;

    rows.push({
      id: pt.id,
      side,
      entryPrice: entry,
      finalPrice: final,
      size,
      pnl,
      win,
      favoritePrice,
      liquidity: liq,
      spread: spr,
      daysToResolution: dtr,
      category: cat ?? "?",
      walletGlobal: ot.wallet?.globalScore ?? NaN,
      walletSideOthersAvgPnl: wsoAvg,
      walletSideOthersN: others.length,
      eqScore: scoreTradeByMarket(
        {
          side,
          currentPrice: favoritePrice,
          priceMovementSinceEntry: 0,
          spread: spr,
          liquidity: liq,
          volume: 0,
          daysToResolution: dtr,
          detectedPrice: favoritePrice,
        },
        DEFAULT_RULES,
      ).score,
    });
  }

  console.log(`usable rows: ${rows.length}`);
  const totPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const totWin = rows.filter((r) => r.win).length;
  console.log(`TOTAL pnl=${totPnl >= 0 ? "+" : ""}$${totPnl.toFixed(2)}  win=${((totWin / rows.length) * 100).toFixed(0)}%`);

  q(rows, "favoritePrice", "favoritePrice (higher = betting favorite)");
  q(rows, "liquidity", "liquidity at entry");
  q(rows, "spread", "spread at entry");
  q(rows, "daysToResolution", "daysToResolution at entry");
  q(rows, "walletGlobal", "wallet globalScore");
  q(rows, "walletSideOthersAvgPnl", "wallet-side OOS avgPnl (other copies)");
  q(rows, "eqScore", "EQUATION SCORE (current fl term)");

  // scoreTrade decision (with favoritePrice gate) — does it select profitable trades?
  let copiedPnl = 0, copiedN = 0, copiedWin = 0;
  let skippedPnl = 0, skippedN = 0;
  for (const r of rows) {
    const dec = scoreTrade(
      { walletGlobalScore: r.walletGlobal, priceMovementSinceEntry: 0, spread: r.spread, liquidity: r.liquidity, volume: 0, timeToResolution: r.daysToResolution, currentPrice: r.favoritePrice, side: r.side },
      DEFAULT_RULES,
    ).decision;
    if (dec === "paper_copy") { copiedPnl += r.pnl; copiedN++; if (r.win) copiedWin++; }
    else { skippedPnl += r.pnl; skippedN++; }
  }
  console.log(`\n## scoreTrade DECISION (favoritePrice gate)`);
  console.log(`  COPIED  n=${String(copiedN).padEnd(3)} win=${copiedN ? ((copiedWin / copiedN) * 100).toFixed(0).padStart(3) : "  0"}%  pnl=${copiedPnl >= 0 ? "+" : ""}$${copiedPnl.toFixed(2)}`);
  console.log(`  SKIPPED n=${String(skippedN).padEnd(3)} pnl=${skippedPnl >= 0 ? "+" : ""}$${skippedPnl.toFixed(2)}`);

  // category breakdown
  console.log(`\n## category breakdown`);
  const byCat = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category)!.push(r);
  }
  for (const [c, rs] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const p = rs.reduce((s, r) => s + r.pnl, 0);
    const w = rs.filter((r) => r.win).length;
    console.log(`  ${String(c).padEnd(12)} n=${String(rs.length).padEnd(3)} win=${((w / rs.length) * 100).toFixed(0).padStart(3)}%  pnl=${p >= 0 ? "+" : ""}$${p.toFixed(2)}`);
  }

  // side breakdown
  console.log(`\n## side breakdown`);
  for (const side of ["BUY", "SELL"]) {
    const rs = rows.filter((r) => r.side === side);
    const p = rs.reduce((s, r) => s + r.pnl, 0);
    const w = rs.filter((r) => r.win).length;
    console.log(`  ${side.padEnd(5)} n=${String(rs.length).padEnd(3)} win=${((w / rs.length) * 100).toFixed(0).padStart(3)}%  pnl=${p >= 0 ? "+" : ""}$${p.toFixed(2)}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
