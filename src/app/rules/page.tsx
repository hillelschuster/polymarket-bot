import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function RulesPage() {
  const [activeRuleSet, ruleChanges] = await Promise.all([
    prisma.ruleSet.findFirst({ where: { active: true }, orderBy: { version: "desc" } }),
    prisma.ruleChange.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  const hasData = activeRuleSet != null || ruleChanges.length > 0;

  if (!hasData) {
    return (
      <main className="p-6">
        <h1 className="mb-4 text-xl font-semibold">Rules</h1>
        <p className="text-zinc-400">No data. Run <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-sm">npm run seed</code>.</p>
      </main>
    );
  }

  return (
    <main className="space-y-6 p-6">
      <h1 className="text-xl font-semibold">Rules</h1>

      {activeRuleSet && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-zinc-400">
            Active Rule Set — v{activeRuleSet.version}
          </h2>
          <pre className="overflow-x-auto rounded border border-zinc-700 bg-zinc-900 p-4 text-xs">
            {JSON.stringify(JSON.parse(activeRuleSet.rulesJson), null, 2)}
          </pre>
        </section>
      )}

      {ruleChanges.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-zinc-400">Change History ({ruleChanges.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-zinc-700 text-zinc-400">
                  <th className="pb-2 pr-3">Version</th>
                  <th className="pb-2 pr-3">Reason</th>
                  <th className="pb-2 pr-3">Evidence</th>
                  <th className="pb-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {ruleChanges.map((rc) => (
                  <tr key={rc.id} className="border-b border-zinc-800">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {rc.oldRuleSetId} &rarr; {rc.newRuleSetId}
                    </td>
                    <td className="py-2 pr-3 text-zinc-300">{rc.reason}</td>
                    <td className="py-2 pr-3 max-w-xs truncate text-zinc-400">
                      {rc.evidenceSummary ?? "—"}
                    </td>
                    <td className="py-2 text-zinc-500">{rc.createdAt.toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
