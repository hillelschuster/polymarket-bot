/** One-time: refresh stale wallet statuses using the corrected thresholds. */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // Find all wallets currently marked "ignore" that should be "watch" or "track"
  const ignored = await prisma.walletProfile.findMany({ where: { status: "ignore" } });
  let fixed = 0;
  for (const w of ignored) {
    const g = w.globalScore ?? 0;
    const newStatus = g >= 20 ? "track" : g >= 10 ? "watch" : "ignore";
    if (newStatus !== "ignore") {
      await prisma.walletProfile.update({ where: { id: w.id }, data: { status: newStatus } });
      console.log(`  ${w.address.slice(0, 16)}: ignore → ${newStatus} (score=${g.toFixed(2)})`);
      fixed++;
    }
  }
  console.log(`\nRefreshed ${fixed} stale statuses.`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
