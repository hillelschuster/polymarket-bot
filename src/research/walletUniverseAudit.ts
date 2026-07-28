import {
  paginateLeaderboard,
  type LeaderboardCategory,
  type LeaderboardParams,
  type LeaderboardRow,
} from "../adapters/leaderboard.js";

type Scope = {
  name: string;
  total: number;
  category: LeaderboardCategory;
  timePeriod: NonNullable<LeaderboardParams["timePeriod"]>;
};

type WalletAudit = {
  address: string;
  userName: string;
  scopes: { name: string; rank: number; pnl: number; volume: number; turnoverEfficiency: number }[];
};

const SCOPES: Scope[] = [
  { name: "overall-day", total: 300, category: "OVERALL", timePeriod: "DAY" },
  { name: "overall-week", total: 300, category: "OVERALL", timePeriod: "WEEK" },
  { name: "overall-month", total: 500, category: "OVERALL", timePeriod: "MONTH" },
  { name: "overall-all", total: 500, category: "OVERALL", timePeriod: "ALL" },
  { name: "sports-month", total: 250, category: "SPORTS", timePeriod: "MONTH" },
  { name: "politics-month", total: 250, category: "POLITICS", timePeriod: "MONTH" },
  { name: "crypto-month", total: 200, category: "CRYPTO", timePeriod: "MONTH" },
  { name: "culture-month", total: 200, category: "CULTURE", timePeriod: "MONTH" },
];

function addScope(map: Map<string, WalletAudit>, scope: Scope, row: LeaderboardRow): void {
  const address = row.id.toLowerCase();
  const wallet = map.get(address) ?? { address, userName: row.userName, scopes: [] };
  wallet.userName ||= row.userName;
  wallet.scopes.push({
    name: scope.name,
    rank: row.rank,
    pnl: row.totalPnl,
    volume: row.volume,
    turnoverEfficiency: row.roi,
  });
  map.set(address, wallet);
}

function persistenceScore(wallet: WalletAudit): number {
  // Audit-only ranking: reward repeated appearance across independent horizons/categories.
  // It is intentionally not a production trust score.
  return wallet.scopes.reduce((score, scope) => {
    const horizonWeight = scope.name.includes("month") ? 3 : scope.name.includes("week") ? 2 : 1;
    return score + horizonWeight / Math.log2(Math.max(2, scope.rank + 1));
  }, 0);
}

async function main(): Promise<void> {
  const wallets = new Map<string, WalletAudit>();
  const rowsByScope = new Map<string, LeaderboardRow[]>();

  for (const scope of SCOPES) {
    console.log(`fetching ${scope.name} top ${scope.total}...`);
    const rows = await paginateLeaderboard(scope.total, {
      category: scope.category,
      timePeriod: scope.timePeriod,
      orderBy: "PNL",
    });
    rowsByScope.set(scope.name, rows);
    for (const row of rows) addScope(wallets, scope, row);
  }

  const day = new Set((rowsByScope.get("overall-day") ?? []).map((row) => row.id.toLowerCase()));
  const month = new Set((rowsByScope.get("overall-month") ?? []).map((row) => row.id.toLowerCase()));
  const all = new Set((rowsByScope.get("overall-all") ?? []).map((row) => row.id.toLowerCase()));
  const dayOnly = [...day].filter((address) => !month.has(address) && !all.has(address));
  const durable = [...wallets.values()].filter((wallet) => wallet.scopes.length >= 3);
  const categorySpecialists = [...wallets.values()].filter((wallet) =>
    wallet.scopes.some((scope) => /sports|politics|crypto|culture/.test(scope.name)),
  );

  const ranked = [...wallets.values()].sort((a, b) =>
    persistenceScore(b) - persistenceScore(a)
    || Math.min(...a.scopes.map((scope) => scope.rank)) - Math.min(...b.scopes.map((scope) => scope.rank)),
  );

  const result = {
    generatedAt: new Date().toISOString(),
    scopes: Object.fromEntries([...rowsByScope].map(([name, rows]) => [name, rows.length])),
    uniqueWallets: wallets.size,
    dayTopCount: day.size,
    dayOnlyCount: dayOnly.length,
    dayOverlapWithMonthPct: day.size ? ((day.size - dayOnly.length) / day.size) * 100 : 0,
    walletsInThreeOrMoreScopes: durable.length,
    categorySpecialistCandidates: categorySpecialists.length,
    topPersistent: ranked.slice(0, 50).map((wallet) => ({
      address: wallet.address,
      userName: wallet.userName,
      auditScore: Number(persistenceScore(wallet).toFixed(4)),
      scopeCount: wallet.scopes.length,
      scopes: wallet.scopes,
    })),
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("\n=== WALLET UNIVERSE AUDIT ===");
  console.log(`unique across scopes: ${result.uniqueWallets}`);
  console.log(`day leaderboard wallets absent from MONTH and ALL: ${result.dayOnlyCount}/${result.dayTopCount}`);
  console.log(`day overlap with durable horizons: ${result.dayOverlapWithMonthPct.toFixed(1)}%`);
  console.log(`wallets appearing in >=3 scopes: ${result.walletsInThreeOrMoreScopes}`);
  console.log(`category specialist candidates: ${result.categorySpecialistCandidates}`);
  console.log("\nTop repeated wallets (audit only, not a production score):");
  for (const wallet of result.topPersistent.slice(0, 20)) {
    console.log(
      `${wallet.userName || wallet.address.slice(0, 10)} | scopes=${wallet.scopeCount} | score=${wallet.auditScore} | ${wallet.scopes.map((scope) => `${scope.name}#${scope.rank}`).join(", ")}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
