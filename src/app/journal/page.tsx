import { prisma } from "@/lib/db";

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

export default async function JournalPage() {
  const entries = await prisma.decisionJournal.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { observedTrade: true },
  });

  if (entries.length === 0) {
    return (
      <main className="p-6">
        <h1 className="mb-4 text-xl font-semibold">Decision Journal</h1>
        <p className="text-zinc-400">No data. Run <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-sm">npm run seed</code>.</p>
      </main>
    );
  }

  return (
    <main className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">Decision Journal ({entries.length})</h1>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-700 text-zinc-400">
              <th className="pb-2 pr-3">Decision</th>
              <th className="pb-2 pr-3">Score</th>
              <th className="pb-2 pr-3">Wallet</th>
              <th className="pb-2 pr-3">Market</th>
              <th className="pb-2 pr-3">Reasons</th>
              <th className="pb-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-zinc-800">
                <td className="py-2 pr-3"><Badge decision={e.decision} /></td>
                <td className="py-2 pr-3">{e.copyScore?.toFixed(1) ?? "—"}</td>
                <td className="py-2 pr-3 font-mono text-xs text-zinc-300">
                  <a href={`/wallet/${e.walletAddress}`} className="text-blue-400 hover:underline">
                    {e.walletAddress.slice(0, 6)}&hellip;
                  </a>
                </td>
                <td className="py-2 pr-3 text-zinc-300">
                  {e.observedTrade?.marketQuestion ?? e.marketId.slice(0, 12)}
                </td>
                <td className="py-2 pr-3 max-w-xs truncate text-zinc-400">
                  {e.reasonsJson ?? "—"}
                </td>
                <td className="py-2 text-zinc-500">{e.createdAt.toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
