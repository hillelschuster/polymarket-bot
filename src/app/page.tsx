import { prisma } from "@/lib/db";
import { LineChart } from "@/app/components/LineChart";
import type { DecisionJournal } from "@prisma/client";

export const dynamic = "force-dynamic";

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-700 bg-zinc-900 p-4">
      <div className="text-sm text-zinc-400">{label}</div>
      <div className="text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}

function Badge({ decision }: { decision: string }) {
  const colors: Record<string, string> = {
    paper_copy: "bg-emerald-900 text-emerald-300",
    watchlist: "bg-amber-900 text-amber-300",
    skip: "bg-zinc-700 text-zinc-300",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${colors[decision] ?? "bg-zinc-700 text-zinc-300"}`}>
      {decision}
    </span>
  );
}

export default async function OverviewPage() {
  const [pnlAgg, resolvedTrades, walletCount, ruleCount, recentDecisions, pnlSnapshots] =
    await Promise.all([
      prisma.paperTrade.aggregate({ _sum: { realizedPnl: true } }),
      prisma.paperTrade.findMany({ where: { status: "resolved" }, select: { realizedPnl: true } }),
      prisma.walletProfile.count(),
      prisma.ruleSet.count(),
      prisma.decisionJournal.findMany({
        take: 5,
        orderBy: { createdAt: "desc" },
        include: { observedTrade: true },
      }),
      prisma.pnlSnapshot.findMany({
        orderBy: { collectedAt: "asc" },
        take: 100,
        select: { pnl: true, collectedAt: true },
      }),
    ]);

  const totalPnl = pnlAgg._sum.realizedPnl ?? 0;
  const wins = resolvedTrades.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const winRate =
    resolvedTrades.length > 0
      ? ((wins / resolvedTrades.length) * 100).toFixed(1)
      : "—";

  const hasData = walletCount > 0;

  if (!hasData) {
    return (
      <main className="p-6">
        <h1 className="mb-4 text-xl font-semibold">Overview</h1>
        <p className="text-zinc-400">No data. Run <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-sm">npm run seed</code>.</p>
      </main>
    );
  }

  return (
    <main className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">Overview</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card label="Paper PnL" value={`$${totalPnl.toFixed(2)}`} />
        <Card label="Win Rate" value={`${winRate}%`} />
        <Card label="Wallets Tracked" value={String(walletCount)} />
        <Card label="Rule Sets" value={String(ruleCount)} />
      </div>

      {pnlSnapshots.length > 0 && (
        <div className="rounded border border-zinc-700 bg-zinc-900 p-4">
          <h2 className="mb-2 text-sm font-medium text-zinc-400">PnL Over Time</h2>
          <LineChart points={pnlSnapshots.map((s) => s.pnl ?? 0)} width={600} height={140} />
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-medium text-zinc-400">Recent Decisions</h2>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-700 text-zinc-400">
              <th className="pb-2 pr-4">Decision</th>
              <th className="pb-2 pr-4">Score</th>
              <th className="pb-2 pr-4">Market</th>
              <th className="pb-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {recentDecisions.map((d) => (
              <tr key={d.id} className="border-b border-zinc-800">
                <td className="py-2 pr-4"><Badge decision={d.decision} /></td>
                <td className="py-2 pr-4">{d.copyScore?.toFixed(1) ?? "—"}</td>
                <td className="py-2 pr-4 text-zinc-300">{d.observedTrade?.marketQuestion ?? d.marketId.slice(0, 10)}</td>
                <td className="py-2 text-zinc-500">{d.createdAt.toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
