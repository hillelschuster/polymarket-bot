import { prisma } from "@/lib/db";
import Link from "next/link";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

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

export default async function WalletProfilePage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const wallet = await prisma.walletProfile.findUnique({ where: { address } });

  if (!wallet) notFound();

  const [trades, decisions, paperTrades] = await Promise.all([
    prisma.observedTrade.findMany({
      where: { walletAddress: address },
      orderBy: { timestamp: "desc" },
      take: 50,
    }),
    prisma.decisionJournal.findMany({
      where: { walletAddress: address },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.paperTrade.findMany({
      where: { walletAddress: address },
      orderBy: { openedAt: "desc" },
      take: 20,
    }),
  ]);

  const catStrengths: Record<string, number> = wallet.categoryStrengthsJson
    ? JSON.parse(wallet.categoryStrengthsJson)
    : {};

  return (
    <main className="space-y-6 p-6">
      <div>
        <Link href="/rankings" className="text-sm text-blue-400 hover:underline">&larr; Rankings</Link>
        <h1 className="mt-1 text-xl font-semibold">{wallet.label ?? address}</h1>
        <p className="font-mono text-xs text-zinc-500">{address}</p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <ScoreCard label="Global Score" value={wallet.globalScore} />
        <ScoreCard label="ROI (30d)" value={wallet.roi30d != null ? `${(wallet.roi30d * 100).toFixed(1)}%` : null} />
        <ScoreCard label="Win Rate" value={wallet.winRate30d != null ? `${(wallet.winRate30d * 100).toFixed(1)}%` : null} />
        <ScoreCard label="Status" value={wallet.status} />
        <ScoreCard label="Consistency" value={wallet.consistencyScore} />
        <ScoreCard label="Copyability" value={wallet.copyabilityScore} />
        <ScoreCard label="One-Hit Penalty" value={wallet.oneHitWonderPenalty} />
        <ScoreCard label="Best Category" value={wallet.bestCategory} />
      </div>

      {Object.keys(catStrengths).length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-medium text-zinc-400">Category Strengths</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(catStrengths).map(([cat, score]) => (
              <span key={cat} className="rounded bg-zinc-800 px-2 py-1 text-xs">
                {cat}: {score.toFixed(1)}
              </span>
            ))}
          </div>
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-400">Recent Trades ({trades.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-700 text-zinc-400">
                <th className="pb-2 pr-4">Market</th>
                <th className="pb-2 pr-4">Side</th>
                <th className="pb-2 pr-4">Size</th>
                <th className="pb-2">Time</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-b border-zinc-800">
                  <td className="py-2 pr-4 text-zinc-300">{t.marketQuestion ?? t.marketId.slice(0, 10)}</td>
                  <td className="py-2 pr-4">{t.side ?? "—"}</td>
                  <td className="py-2 pr-4">{t.size != null ? `$${t.size.toFixed(2)}` : "—"}</td>
                  <td className="py-2 text-zinc-500">{t.timestamp?.toLocaleString() ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-400">Decisions ({decisions.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-700 text-zinc-400">
                <th className="pb-2 pr-4">Decision</th>
                <th className="pb-2 pr-4">Score</th>
                <th className="pb-2 pr-4">Market</th>
                <th className="pb-2">Date</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d) => (
                <tr key={d.id} className="border-b border-zinc-800">
                  <td className="py-2 pr-4"><Badge decision={d.decision} /></td>
                  <td className="py-2 pr-4">{d.copyScore?.toFixed(1) ?? "—"}</td>
                  <td className="py-2 pr-4 text-zinc-300">{d.marketId.slice(0, 10)}</td>
                  <td className="py-2 text-zinc-500">{d.createdAt.toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-400">Paper Trades ({paperTrades.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-700 text-zinc-400">
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Side</th>
                <th className="pb-2 pr-4">Size</th>
                <th className="pb-2 pr-4">Entry</th>
                <th className="pb-2 pr-4">Current</th>
                <th className="pb-2">PnL</th>
              </tr>
            </thead>
            <tbody>
              {paperTrades.map((pt) => (
                <tr key={pt.id} className="border-b border-zinc-800">
                  <td className="py-2 pr-4">{pt.status}</td>
                  <td className="py-2 pr-4">{pt.side ?? "—"}</td>
                  <td className="py-2 pr-4">{pt.simulatedPositionSize != null ? `$${pt.simulatedPositionSize.toFixed(2)}` : "—"}</td>
                  <td className="py-2 pr-4">{pt.entryPrice?.toFixed(3) ?? "—"}</td>
                  <td className="py-2 pr-4">{pt.currentPrice?.toFixed(3) ?? "—"}</td>
                  <td className="py-2 font-medium">${(pt.realizedPnl ?? pt.unrealizedPnl ?? 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function ScoreCard({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="rounded border border-zinc-700 bg-zinc-900 p-3">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="text-lg font-medium">{value ?? "—"}</div>
    </div>
  );
}
