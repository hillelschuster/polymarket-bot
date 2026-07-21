import { prisma } from "@/lib/db";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function RankingsPage() {
  const wallets = await prisma.walletProfile.findMany({
    orderBy: { globalScore: { sort: "desc", nulls: "last" } },
    take: 500,
  });

  if (wallets.length === 0) {
    return (
      <main className="p-6">
        <h1 className="mb-4 text-xl font-semibold">Wallet Rankings</h1>
        <p className="text-zinc-400">No data. Run <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-sm">npm run seed</code>.</p>
      </main>
    );
  }

  return (
    <main className="p-6">
      <h1 className="mb-4 text-xl font-semibold">Wallet Rankings</h1>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-700 text-zinc-400">
              <th className="pb-2 pr-3">#</th>
              <th className="pb-2 pr-4">Wallet</th>
              <th className="pb-2 pr-4">Score</th>
              <th className="pb-2 pr-4">ROI (30d)</th>
              <th className="pb-2 pr-4">Win Rate</th>
              <th className="pb-2 pr-4">Consistency</th>
              <th className="pb-2 pr-4">Copyability</th>
              <th className="pb-2">One-Hit</th>
            </tr>
          </thead>
          <tbody>
            {wallets.map((w, i) => (
              <tr key={w.id} className="border-b border-zinc-800">
                <td className="py-2 pr-3 text-zinc-500">{i + 1}</td>
                <td className="py-2 pr-4">
                  <Link href={`/wallet/${w.address}`} className="text-blue-400 hover:underline">
                    {w.label ?? `${w.address.slice(0, 6)}…${w.address.slice(-4)}`}
                  </Link>
                </td>
                <td className="py-2 pr-4 font-medium">{w.globalScore?.toFixed(1) ?? "—"}</td>
                <td className="py-2 pr-4">{w.roi30d != null ? `${(w.roi30d * 100).toFixed(1)}%` : "—"}</td>
                <td className="py-2 pr-4">{w.winRate30d != null ? `${(w.winRate30d * 100).toFixed(1)}%` : "—"}</td>
                <td className="py-2 pr-4">{w.consistencyScore?.toFixed(1) ?? "—"}</td>
                <td className="py-2 pr-4">{w.copyabilityScore?.toFixed(1) ?? "—"}</td>
                <td className="py-2">
                  {(w.oneHitWonderPenalty ?? 0) > 0 ? (
                    <span className="rounded bg-red-900 px-1.5 py-0.5 text-xs text-red-300">YES</span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
