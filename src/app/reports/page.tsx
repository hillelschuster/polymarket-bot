import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const reports = await prisma.dailyReport.findMany({
    orderBy: { date: "desc" },
    take: 30,
  });

  if (reports.length === 0) {
    return (
      <main className="p-6">
        <h1 className="mb-4 text-xl font-semibold">Reports</h1>
        <p className="text-zinc-400">No data. Run <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-sm">npm run seed</code>.</p>
      </main>
    );
  }

  const latest = reports[0];

  return (
    <main className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">Reports</h1>

      <section className="rounded border border-zinc-700 bg-zinc-900 p-4">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">
          Latest Report — {latest.date.toLocaleDateString()}
        </h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <ReportCard label="Resolved Wallet-Copy PnL" value={latest.resolvedWalletCopyPnl != null ? `$${latest.resolvedWalletCopyPnl.toFixed(2)}` : null} />
          <ReportCard label="Wallet-Copy Win Rate" value={latest.resolvedWalletCopyWinRate != null ? `${(latest.resolvedWalletCopyWinRate * 100).toFixed(1)}%` : null} />
          <ReportCard label="Resolved Strategy PnL" value={latest.resolvedStrategyPnl != null ? `$${latest.resolvedStrategyPnl.toFixed(2)}` : null} />
          <ReportCard label="Legacy Closed Stop-Loss" value={latest.legacyClosedStopLossPnl != null ? `$${latest.legacyClosedStopLossPnl.toFixed(2)}` : null} />
          <ReportCard label="Open Wallet-Copy Unrealized" value={latest.openWalletCopyUnrealizedPnl != null ? `$${latest.openWalletCopyUnrealizedPnl.toFixed(2)}` : null} />
          <ReportCard label="Open Strategy Unrealized" value={latest.openStrategyUnrealizedPnl != null ? `$${latest.openStrategyUnrealizedPnl.toFixed(2)}` : null} />
          <ReportCard label="Combined Accounting (incl. legacy)" value={latest.combinedAccountingTotal != null ? `$${latest.combinedAccountingTotal.toFixed(2)}` : null} />
          <ReportCard label="Open Positions" value={latest.openPositions} />
          <ReportCard label="New Signals" value={latest.newSignals} />
          <ReportCard label="Copied" value={latest.copiedSignals} />
          <ReportCard label="Watched" value={latest.watchedSignals} />
          <ReportCard label="Skipped" value={latest.skippedSignals} />
          <ReportCard label="Sent to Telegram" value={latest.sentToTelegram ? "Yes" : "No"} />
        </div>

        {latest.bestWalletsJson && (
          <div className="mt-4">
            <h3 className="mb-1 text-xs font-medium text-zinc-500">Best Wallets</h3>
            <pre className="rounded bg-zinc-800 p-2 text-xs">{prettyJson(latest.bestWalletsJson)}</pre>
          </div>
        )}

        {latest.summary && (
          <div className="mt-4">
            <h3 className="mb-1 text-xs font-medium text-zinc-500">Summary</h3>
            <p className="text-sm text-zinc-300">{latest.summary}</p>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-zinc-400">All Reports ({reports.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-700 text-zinc-400">
                <th className="pb-2 pr-3">Date</th>
                <th className="pb-2 pr-3">Wallet PnL</th>
                <th className="pb-2 pr-3">Wallet WR</th>
                <th className="pb-2 pr-3">Open</th>
                <th className="pb-2 pr-3">Signals</th>
                <th className="pb-2">Sent</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id} className="border-b border-zinc-800">
                  <td className="py-2 pr-3">{r.date.toLocaleDateString()}</td>
                  <td className={`py-2 pr-3 font-medium ${(r.resolvedWalletCopyPnl ?? r.paperPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {(r.resolvedWalletCopyPnl ?? r.paperPnl) != null ? `$${(r.resolvedWalletCopyPnl ?? r.paperPnl)!.toFixed(2)}` : "—"}
                  </td>
                  <td className="py-2 pr-3">{(r.resolvedWalletCopyWinRate ?? r.winRate) != null ? `${((r.resolvedWalletCopyWinRate ?? r.winRate)! * 100).toFixed(1)}%` : "—"}</td>
                  <td className="py-2 pr-3">{r.openPositions ?? "—"}</td>
                  <td className="py-2 pr-3">{r.newSignals ?? "—"}</td>
                  <td className="py-2">{r.sentToTelegram ? "✓" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function ReportCard({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="rounded bg-zinc-800 p-2.5">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="text-base font-medium">{value ?? "—"}</div>
    </div>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
