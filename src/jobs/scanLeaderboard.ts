// Job: scan:leaderboard. Pull leaderboard -> LeaderboardScan + upsert WalletProfile rows. SPEC §10.
import { prisma } from "../lib/db.js";
import { paginateLeaderboard } from "../adapters/leaderboard.js";
import { isLive } from "../lib/config.js";

export async function runScanLeaderboard(): Promise<void> {
  const rows = await paginateLeaderboard(500);
  const scan = await prisma.leaderboardScan.create({
    data: {
      source: "polymarket-leaderboard",
      scannedAt: new Date(),
      walletCount: rows.length,
      lookbackDays: 30,
      rawSummaryJson: JSON.stringify({ live: isLive, count: rows.length }),
    },
  });
  for (const row of rows) {
    await prisma.walletProfile.upsert({
      where: { address: row.id },
      create: {
        address: row.id,
        label: row.userName || null,
        sourceRank: row.rank || null,
        status: "watch",
        tradeCount30d: 0,
        resolvedTradeCount30d: 0,
        scanId: scan.id,
      },
      update: {
        label: row.userName || null,
        sourceRank: row.rank || null,
        scanId: scan.id,
      },
    });
  }
  console.log(`scanLeaderboard done: ${rows.length} wallets, scan ${scan.id}`);
}

if (require.main === module) runScanLeaderboard().catch(console.error);
