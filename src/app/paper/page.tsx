import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function PaperTradesPage() {
  const [trades, agg] = await Promise.all([
    prisma.paperTrade.findMany({
      orderBy: { openedAt: "desc" },
      take: 200,
      include: { decisionJournal: { include: { observedTrade: true } } },
    }),
    prisma.paperTrade.aggregate({
      _sum: { realizedPnl: true, simulatedPositionSize: true },
      _count: true,
    }),
  ]);

  if (trades.length === 0) {
    return (
      <main className="p-6">
        <h1 className="mb-4 text-xl font-semibold">Paper Trades</h1>
        <p className="text-zinc-400">No data. Run <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-sm">npm run seed</code>.</p>
      </main>
    );
  }

  const totalPnl = agg._sum.realizedPnl ?? 0;
  const totalSize = agg._sum.simulatedPositionSize ?? 0;
  const openTrades = trades.filter((t) => t.status === "open").length;
  const resolvedTrades = trades.filter((t) => t.status === "resolved").length;

  return (
    <main className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">Paper Trades</h1>

      <div className="grid grid-cols-4 gap-4">
        <SummaryCard label="Total PnL" value={`$${totalPnl.toFixed(2)}`} />
        <SummaryCard label="Total Size" value={`$${totalSize.toFixed(2)}`} />
        <SummaryCard label="Open" value={String(openTrades)} />
        <SummaryCard label="Resolved" value={String(resolvedTrades)} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-700 text-zinc-400">
              <th className="pb-2 pr-3">Status</th>
              <th className="pb-2 pr-3">Market</th>
              <th className="pb-2 pr-3">Side</th>
              <th className="pb-2 pr-3">Size</th>
              <th className="pb-2 pr-3">Entry</th>
              <th className="pb-2 pr-3">Current</th>
              <th className="pb-2">PnL</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.id} className="border-b border-zinc-800">
                <td className="py-2 pr-3">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${
                    t.status === "open" ? "bg-blue-900 text-blue-300"
                    : t.status === "resolved" ? "bg-zinc-700 text-zinc-300"
                    : "bg-amber-900 text-amber-300"
                  }`}>{t.status}</span>
                </td>
                <td className="py-2 pr-3 text-zinc-300">
                  {t.decisionJournal?.observedTrade?.marketQuestion ?? t.marketId.slice(0, 12)}
                </td>
                <td className="py-2 pr-3">{t.side ?? "—"}</td>
                <td className="py-2 pr-3">{t.simulatedPositionSize != null ? `$${t.simulatedPositionSize.toFixed(2)}` : "—"}</td>
                <td className="py-2 pr-3">{t.entryPrice?.toFixed(3) ?? "—"}</td>
                <td className="py-2 pr-3">{t.currentPrice?.toFixed(3) ?? "—"}</td>
                <td className={`py-2 font-medium ${(t.realizedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  ${(t.realizedPnl ?? t.unrealizedPnl ?? 0).toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-700 bg-zinc-900 p-3">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="text-lg font-medium">{value}</div>
    </div>
  );
}
