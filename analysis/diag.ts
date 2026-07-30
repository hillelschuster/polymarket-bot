/** Quick diagnostic: check SELL trades, closed trades, and PnL divergence sources. */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const trades = await prisma.paperTrade.findMany();

  // Status breakdown
  const byStatus = new Map<string, { count: number; pnl: number }>();
  for (const t of trades) {
    const pnl = t.status === "open" ? (t.unrealizedPnl ?? 0) : (t.realizedPnl ?? 0);
    const cur = byStatus.get(t.status) ?? { count: 0, pnl: 0 };
    cur.count++;
    cur.pnl += pnl;
    byStatus.set(t.status, cur);
  }
  console.log("=== BY STATUS ===");
  for (const [s, v] of byStatus) console.log(`  ${s}: ${v.count} trades, PnL $${v.pnl.toFixed(2)}`);

  // Side breakdown
  const bySide = new Map<string, number>();
  for (const t of trades) bySide.set(t.side ?? "null", (bySide.get(t.side ?? "null") ?? 0) + 1);
  console.log("\n=== BY SIDE ===");
  for (const [s, c] of bySide) console.log(`  ${s}: ${c}`);

  // Closed (stop-lossed) trades detail
  const closed = trades.filter((t) => t.status === "closed");
  console.log(`\n=== CLOSED (STOP-LOSS) TRADES: ${closed.length} ===`);
  for (const t of closed) {
    console.log(`  ${t.id.slice(0, 8)} entry=${t.entryPrice} cash=${t.simulatedPositionSize} pnl=${t.realizedPnl} side=${t.side} slug=${(t.slug ?? "").slice(0, 40)}`);
  }

  // PnL divergence: compare DB vs formula for resolved trades
  const resolved = trades.filter((t) => t.status === "resolved");
  console.log(`\n=== RESOLVED PnL DIVERGENCE (top 10 by |diff|) ===`);
  const diffs = resolved.map((t) => {
    const entry = t.entryPrice ?? 0.5;
    const cash = t.simulatedPositionSize ?? 10;
    const won = (t.realizedPnl ?? 0) > 0;
    const side = (t.side ?? "BUY").toUpperCase();
    let formulaPnl: number;
    if (side === "BUY" || side === "YES") {
      formulaPnl = won ? cash * (1 - entry) / entry : -cash;
    } else {
      // SELL/NO: win means price went to 0
      formulaPnl = won ? cash : -cash * (1 - entry) / entry;
    }
    return { id: t.id.slice(0, 8), entry, cash, dbPnl: t.realizedPnl ?? 0, formulaPnl, diff: Math.abs((t.realizedPnl ?? 0) - formulaPnl), side, won };
  }).sort((a, b) => b.diff - a.diff);

  for (const d of diffs.slice(0, 10)) {
    console.log(`  ${d.id} side=${d.side} entry=${d.entry.toFixed(3)} cash=$${d.cash.toFixed(0)} db=$${d.dbPnl.toFixed(2)} formula=$${d.formulaPnl.toFixed(2)} diff=$${d.diff.toFixed(2)} won=${d.won}`);
  }

  // Check: are there resolved trades where DB PnL doesn't match binary resolution?
  const mismatches = diffs.filter((d) => d.diff > 0.05);
  console.log(`\n  Mismatches (diff > $0.05): ${mismatches.length} of ${resolved.length} resolved`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
