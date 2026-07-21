import { prisma } from "@/lib/db";
import { LineChart } from "@/app/components/LineChart";
import { compareStrategies, type BenchmarkTrade } from "@/lib/benchmark";

export const dynamic = "force-dynamic";

export default async function PerformancePage() {
  const snapshots = await prisma.pnlSnapshot.findMany({
    orderBy: { collectedAt: "asc" },
    take: 500,
    select: { pnl: true, collectedAt: true },
  });

  // Build BenchmarkTrade from resolved PaperTrade (bot) + OutcomeReview (watchlist/skipped)
  const paperTrades = await prisma.paperTrade.findMany({
    where: { status: "resolved", realizedPnl: { not: null } },
    include: { decisionJournal: true },
  });
  const outcomeReviews = await prisma.outcomeReview.findMany({
    where: { simulatedPnl: { not: null }, decisionJournalId: { not: undefined } },
    include: { decisionJournal: true },
  });

  const benchmarkTrades: BenchmarkTrade[] = [
    ...paperTrades.map((pt): BenchmarkTrade => ({
      id: pt.id,
      strategy: "bot",
      pnl: pt.realizedPnl ?? 0,
      marketId: pt.marketId,
      walletAddress: pt.walletAddress,
    })),
    ...outcomeReviews
      .filter((o): o is typeof o & { decisionJournal: NonNullable<typeof o.decisionJournal> } =>
        o.decisionJournal != null && o.decisionJournal.decision === "watchlist"
      )
      .map((o): BenchmarkTrade => ({
        id: o.id,
        strategy: "watchlist",
        pnl: o.simulatedPnl ?? 0,
        marketId: o.decisionJournal.marketId,
        walletAddress: o.decisionJournal.walletAddress,
      })),
    ...outcomeReviews
      .filter((o): o is typeof o & { decisionJournal: NonNullable<typeof o.decisionJournal> } =>
        o.decisionJournal != null && o.decisionJournal.decision === "skip"
      )
      .map((o): BenchmarkTrade => ({
        id: o.id,
        strategy: "skipped",
        pnl: o.simulatedPnl ?? 0,
        marketId: o.decisionJournal.marketId,
        walletAddress: o.decisionJournal.walletAddress,
      })),
  ];

  const benchmark = benchmarkTrades.length > 0 ? compareStrategies(benchmarkTrades) : null;
  const hasData = snapshots.length > 0 || benchmarkTrades.length > 0;

  if (!hasData) {
    return (
      <main className="p-6">
        <h1 className="mb-4 text-xl font-semibold">Performance</h1>
        <p className="text-zinc-400">No data. Run <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-sm">npm run seed</code>.</p>
      </main>
    );
  }

  return (
    <main className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">Performance</h1>

      {snapshots.length > 0 && (
        <div className="rounded border border-zinc-700 bg-zinc-900 p-4">
          <h2 className="mb-2 text-sm font-medium text-zinc-400">PnL Over Time</h2>
          <LineChart points={snapshots.map((s) => s.pnl ?? 0)} width={700} height={160} />
        </div>
      )}

      {benchmark && (
        <div className="rounded border border-zinc-700 bg-zinc-900 p-4">
          <h2 className="mb-3 text-sm font-medium text-zinc-400">Benchmark Comparison</h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <BenchCard label="Bot-Filtered" count={benchmark.botFiltered.count} pnl={benchmark.botFiltered.netPnl} />
            <BenchCard label="Blind Copy (simulated)" count={benchmark.blindCopy.count} pnl={benchmark.blindCopy.netPnl} />
            <BenchCard label="Watchlist" count={benchmark.watchlist.count} pnl={benchmark.watchlist.netPnl} />
            <BenchCard label="Skipped" count={benchmark.skipped.count} pnl={benchmark.skipped.netPnl} />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <div>
              <span className="text-zinc-400">Missed winners:</span>{" "}
              <span className="text-amber-300">{benchmark.missedWinners.length}</span>
            </div>
            <div>
              <span className="text-zinc-400">Avoided losers:</span>{" "}
              <span className="text-emerald-300">{benchmark.avoidedLosers.length}</span>
            </div>
            <div>
              <span className="text-zinc-400">Bad copies:</span>{" "}
              <span className="text-red-300">{benchmark.badCopies.length}</span>
            </div>
            <div>
              <span className="text-zinc-400">Good skips:</span>{" "}
              <span className="text-emerald-300">{benchmark.goodSkips.length}</span>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function BenchCard({ label, count, pnl }: { label: string; count: number; pnl: number }) {
  return (
    <div className="rounded bg-zinc-800 p-3">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="text-lg font-medium">{count} trades</div>
      <div className={`text-sm ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
        ${pnl.toFixed(2)}
      </div>
    </div>
  );
}
