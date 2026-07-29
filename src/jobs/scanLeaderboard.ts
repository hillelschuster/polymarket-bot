// Job: scan:leaderboard. Multi-horizon wallet discovery -> LeaderboardScan + upsert WalletProfile.
// Fetches from MONTH, WEEK, ALL overall + SPORTS/POLITICS/CRYPTO monthly leaderboards.
// Deduplicates the union and stores the best rank per wallet across all scopes.
import { prisma } from "../lib/db.js";
import { paginateLeaderboard, type LeaderboardCategory, type LeaderboardTimePeriod } from "../adapters/leaderboard.js";
import { isLive } from "../lib/config.js";

interface Scope {
  name: string;
  category: LeaderboardCategory;
  timePeriod: LeaderboardTimePeriod;
  total: number;
}

// Discovery scopes: durable horizons first, then category specialists.
// Avoids DAY (dominated by one-hit lucky winners and market makers).
const SCOPES: Scope[] = [
  { name: "overall-month", category: "OVERALL", timePeriod: "MONTH", total: 500 },
  { name: "overall-week", category: "OVERALL", timePeriod: "WEEK", total: 300 },
  { name: "overall-all", category: "OVERALL", timePeriod: "ALL", total: 300 },
  { name: "sports-month", category: "SPORTS", timePeriod: "MONTH", total: 200 },
  { name: "politics-month", category: "POLITICS", timePeriod: "MONTH", total: 150 },
  { name: "crypto-month", category: "CRYPTO", timePeriod: "MONTH", total: 100 },
];

export async function runScanLeaderboard(): Promise<void> {
  // Fetch all scopes and build a deduplicated wallet map
  const walletMap = new Map<string, {
    address: string;
    userName: string;
    bestRank: number;
    scopes: string[];
    totalPnl: number;
    volume: number;
  }>();

  for (const scope of SCOPES) {
    try {
      const rows = await paginateLeaderboard(scope.total, {
        category: scope.category,
        timePeriod: scope.timePeriod,
        orderBy: "PNL",
      });
      for (const row of rows) {
        const addr = row.id.toLowerCase();
        const existing = walletMap.get(addr);
        if (existing) {
          existing.bestRank = Math.min(existing.bestRank, row.rank);
          existing.scopes.push(scope.name);
          // Keep highest PnL (longer horizons have larger absolute values)
          if (row.totalPnl > existing.totalPnl) existing.totalPnl = row.totalPnl;
          if (row.volume > existing.volume) existing.volume = row.volume;
        } else {
          walletMap.set(addr, {
            address: row.id,
            userName: row.userName,
            bestRank: row.rank,
            scopes: [scope.name],
            totalPnl: row.totalPnl,
            volume: row.volume,
          });
        }
      }
      console.log(`  scope ${scope.name}: ${rows.length} wallets`);
    } catch (err) {
      console.error(`  scope ${scope.name} failed:`, (err as Error).message);
    }
  }

  const wallets = [...walletMap.values()];
  const scan = await prisma.leaderboardScan.create({
    data: {
      source: "polymarket-multi-horizon",
      scannedAt: new Date(),
      walletCount: wallets.length,
      lookbackDays: 30,
      rawSummaryJson: JSON.stringify({
        live: isLive,
        scopes: SCOPES.map((s) => s.name),
        uniqueWallets: wallets.length,
      }),
    },
  });

  for (const w of wallets) {
    await prisma.walletProfile.upsert({
      where: { address: w.address },
      create: {
        address: w.address,
        label: w.userName || null,
        sourceRank: w.bestRank,
        status: "watch",
        tradeCount30d: 0,
        resolvedTradeCount30d: 0,
        scanId: scan.id,
        categoryStrengthsJson: JSON.stringify({ _scopes: w.scopes }),
      },
      update: {
        label: w.userName || null,
        sourceRank: Math.min(w.bestRank, 9999),
        scanId: scan.id,
      },
    });
  }
  console.log(`scanLeaderboard done: ${wallets.length} unique wallets from ${SCOPES.length} scopes, scan ${scan.id}`);
}

if (require.main === module) runScanLeaderboard().catch(console.error);
