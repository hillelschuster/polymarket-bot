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

export default async function SignalsPage({
  searchParams,
}: {
  searchParams: Promise<{ decision?: string }>;
}) {
  const { decision } = await searchParams;
  const filter = decision && ["paper_copy", "watchlist", "skip"].includes(decision)
    ? { decision }
    : {};

  const signals = await prisma.decisionJournal.findMany({
    where: filter,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { observedTrade: true },
  });

  const hasData = signals.length > 0 || !decision;

  if (!hasData) {
    return (
      <main className="p-6">
        <h1 className="mb-4 text-xl font-semibold">Trade Signals</h1>
        <p className="text-zinc-400">No data. Run <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-sm">npm run seed</code>.</p>
      </main>
    );
  }

  return (
    <main className="space-y-4 p-6">
      <h1 className="text-xl font-semibold">Trade Signals</h1>

      <div className="flex gap-2">
        {["", "paper_copy", "watchlist", "skip"].map((d) => (
          <a
            key={d}
            href={d ? `/signals?decision=${d}` : "/signals"}
            className={`rounded px-3 py-1 text-xs ${
              (decision ?? "") === d
                ? "bg-blue-700 text-white"
                : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            {d || "all"}
          </a>
        ))}
      </div>

      {signals.length === 0 ? (
        <p className="text-zinc-500">No signals match the filter.</p>
      ) : (
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
              {signals.map((s) => (
                <tr key={s.id} className="border-b border-zinc-800">
                  <td className="py-2 pr-3"><Badge decision={s.decision} /></td>
                  <td className="py-2 pr-3">{s.copyScore?.toFixed(1) ?? "—"}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-zinc-300">
                    {s.walletAddress.slice(0, 6)}&hellip;
                  </td>
                  <td className="py-2 pr-3 text-zinc-300">
                    {s.observedTrade?.marketQuestion ?? s.marketId.slice(0, 12)}
                  </td>
                  <td className="py-2 pr-3 max-w-xs truncate text-zinc-400">
                    {s.reasonsJson ?? "—"}
                  </td>
                  <td className="py-2 text-zinc-500">{s.createdAt.toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
