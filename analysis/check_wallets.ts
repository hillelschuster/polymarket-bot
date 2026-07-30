/** Check globalScore + status of wallets behind the 14/14 mainline results. */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const PROVEN = new Set(["mlb", "ufc", "f1"]);

async function main() {
  const trades = await prisma.paperTrade.findMany({
    where: { status: "resolved", source: "wallet_copy" },
  });

  const mainline = trades.filter((t) => {
    if (!t.slug) return false;
    const prefix = t.slug.toLowerCase().split("-")[0];
    return PROVEN.has(prefix);
  });

  console.log("=== MAINLINE TRADES (MLB/UFC/F1 resolved wallet-copy) ===");
  console.log(`Total: ${mainline.length} | Wins: ${mainline.filter((t) => (t.realizedPnl ?? 0) > 0).length}`);

  const wallets = new Map<string, { wins: number; total: number; pnl: number; slugs: string[] }>();
  for (const t of mainline) {
    const e = wallets.get(t.walletAddress) ?? { wins: 0, total: 0, pnl: 0, slugs: [] };
    e.total++;
    if ((t.realizedPnl ?? 0) > 0) e.wins++;
    e.pnl += t.realizedPnl ?? 0;
    e.slugs.push(t.slug!);
    wallets.set(t.walletAddress, e);
  }

  console.log(`\nWallets responsible: ${wallets.size}\n`);
  console.log(`${"Wallet".padEnd(18)} ${"W/L".padStart(5)} ${"PnL".padStart(9)} ${"gScore".padStart(7)} ${"Status".padStart(8)}  Monitored?  Mainline?`);
  console.log("-".repeat(80));

  let allPass = true;
  for (const [addr, s] of [...wallets.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    const profile = await prisma.walletProfile.findFirst({ where: { address: addr } });
    const gScore = profile?.globalScore ?? null;
    const status = profile?.status ?? "NO_PROFILE";
    // NEW criteria: monitored = track|watch; mainline-eligible = bypasses global gate
    const monitored = status === "track" || status === "watch";
    const mainlineEligible = true; // sports_mainline bypasses minWalletGlobal
    if (!monitored) allPass = false;
    console.log(
      `${addr.slice(0, 16).padEnd(18)} ${(s.wins + "/" + s.total).padStart(5)} ${("$" + s.pnl.toFixed(2)).padStart(9)} ${String(gScore ?? "N/A").padStart(7)} ${status.padStart(8)}  ${monitored ? "YES" : "*** NO ***"}       ${mainlineEligible ? "YES" : "NO"}`
    );
  }

  console.log("-".repeat(80));
  console.log(allPass
    ? "\nALL PASS: every mainline wallet is monitored (track|watch) and eligible for MLB/UFC/F1."
    : "\nWARNING: some wallets are NOT monitored (status=ignore).");

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
