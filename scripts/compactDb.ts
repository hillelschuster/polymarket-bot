/**
 * Safe DB maintenance — prunes ONLY stale/irrelevant data. No bot logic changes.
 *
 * What each run does:
 *  1. NULLs rawTradeJson on every ObservedTrade row — a write-only blob that no
 *     job ever reads (monitorTrades writes it; nothing reads it back).
 *  2. Prunes DecisionJournal rows older than DECISION_JOURNAL_DAYS unless a
 *     PaperTrade, LiveOrder, or OutcomeReview still references them.
 *  3. Prunes ObservedTrade rows older than OBSERVED_TRADE_DAYS that no journal
 *     references (journals keep their trades, so paper-trade history survives).
 *  4. Prunes old PnlSnapshot / LeaderboardScan / MarketSnapshot rows.
 *  5. VACUUM (shrinks the file), then verifies integrity + foreign keys.
 *
 * Retention is a rolling window: run daily (see run_compact.bat / the scheduled
 * task) and the DB stays bounded — the bot only scores trades from the last few
 * hours, and reports use today's rows, so anything older is stale.
 *
 * Run with the SAME DATABASE_URL the bot uses, e.g.:
 *   Windows: DATABASE_URL=file:C:/home/hillel/polymarket-bot-dev.db
 *   WSL:     DATABASE_URL=file:/mnt/c/home/hillel/polymarket-bot-dev.db
 */
import { prisma } from "../src/lib/db";

// ---- Retention policy (days). Tune here; everything older is stale. ----
const OBSERVED_TRADE_DAYS = 14;
const DECISION_JOURNAL_DAYS = 14;
const PNL_SNAPSHOT_DAYS = 60;
const LEADERBOARD_SCAN_DAYS = 60;
const MARKET_SNAPSHOT_DAYS = 60;

const msAgo = (days: number) => Date.now() - days * 86_400_000;

const SIZE_SQL = `SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS bytes`;
const COUNT_SQL = (t: string) => `SELECT COUNT(*) AS n FROM "${t}"`;
const TABLES = [
  "ObservedTrade",
  "DecisionJournal",
  "PnlSnapshot",
  "LeaderboardScan",
  "MarketSnapshot",
  "OutcomeReview",
  "WalletProfile",
  "PaperTrade",
  "RuleSet",
];

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function count(table: string): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(COUNT_SQL(table))) as { n: bigint | number }[];
  return Number(rows[0].n);
}

async function main(): Promise<void> {
  console.log(`compactDb: start ${new Date().toISOString()}`);

  // Wait up to 60s for locks instead of failing if a job is briefly writing.
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 60000");

  const before: Record<string, number> = {};
  for (const t of TABLES) before[t] = await count(t);
  const sizeRows = (await prisma.$queryRawUnsafe(SIZE_SQL)) as { bytes: bigint | number }[];
  const sizeBefore = Number(sizeRows[0].bytes);

  // 1. Drop the write-only trade blobs (never read by any job).
  const blobs = Number(await prisma.$executeRawUnsafe("UPDATE ObservedTrade SET rawTradeJson = NULL"));
  console.log(`rawTradeJson NULLed on ${blobs.toLocaleString()} rows`);

  // 2. Outcome reviews of stale journals (child rows first).
  const djCutoff = msAgo(DECISION_JOURNAL_DAYS);
  const reviews = Number(
    await prisma.$executeRawUnsafe(
      `DELETE FROM OutcomeReview WHERE decisionJournalId IN (
         SELECT dj.id FROM DecisionJournal dj
         WHERE dj.createdAt < ?
           AND NOT EXISTS (SELECT 1 FROM PaperTrade pt WHERE pt.decisionJournalId = dj.id)
           AND NOT EXISTS (SELECT 1 FROM LiveOrder lo WHERE lo.decisionJournalId = dj.id)
       )`,
      djCutoff,
    ),
  );
  console.log(`OutcomeReview pruned: ${reviews}`);

  // 3. Stale journals — never ones tied to paper trades, live orders, or reviews.
  const journals = Number(
    await prisma.$executeRawUnsafe(
      `DELETE FROM DecisionJournal WHERE createdAt < ?
         AND NOT EXISTS (SELECT 1 FROM PaperTrade pt WHERE pt.decisionJournalId = DecisionJournal.id)
         AND NOT EXISTS (SELECT 1 FROM LiveOrder lo WHERE lo.decisionJournalId = DecisionJournal.id)
         AND NOT EXISTS (SELECT 1 FROM OutcomeReview ov WHERE ov.decisionJournalId = DecisionJournal.id)`,
      djCutoff,
    ),
  );
  console.log(`DecisionJournal pruned: ${journals.toLocaleString()}`);

  // 4. Stale trades that no journal references (keeps journal->trade integrity).
  const trades = Number(
    await prisma.$executeRawUnsafe(
      `DELETE FROM ObservedTrade WHERE timestamp < ?
         AND NOT EXISTS (SELECT 1 FROM DecisionJournal dj WHERE dj.observedTradeId = ObservedTrade.id)`,
      msAgo(OBSERVED_TRADE_DAYS),
    ),
  );
  console.log(`ObservedTrade pruned: ${trades.toLocaleString()}`);

  // 5. Old snapshots and scans.
  const pnl = Number(await prisma.$executeRawUnsafe("DELETE FROM PnlSnapshot WHERE collectedAt < ?", msAgo(PNL_SNAPSHOT_DAYS)));
  const lb = Number(await prisma.$executeRawUnsafe("DELETE FROM LeaderboardScan WHERE scannedAt < ?", msAgo(LEADERBOARD_SCAN_DAYS)));
  const ms = Number(await prisma.$executeRawUnsafe("DELETE FROM MarketSnapshot WHERE collectedAt < ?", msAgo(MARKET_SNAPSHOT_DAYS)));
  console.log(`PnlSnapshot pruned: ${pnl.toLocaleString()}, LeaderboardScan pruned: ${lb}, MarketSnapshot pruned: ${ms}`);

  // 6. Reclaim the freed pages.
  await prisma.$executeRawUnsafe("VACUUM");

  // 7. Verify nothing broke.
  const integrity = (await prisma.$queryRawUnsafe("PRAGMA integrity_check")) as { integrity_check: string }[];
  const fk = (await prisma.$queryRawUnsafe("PRAGMA foreign_key_check")) as unknown[];
  const sizeRowsAfter = (await prisma.$queryRawUnsafe(SIZE_SQL)) as { bytes: bigint | number }[];
  const sizeAfter = Number(sizeRowsAfter[0].bytes);

  const after: Record<string, number> = {};
  for (const t of TABLES) after[t] = await count(t);

  console.log("\ncompactDb: results");
  console.log(`  integrity_check: ${integrity[0].integrity_check}`);
  console.log(`  foreign_key_check: ${fk.length === 0 ? "clean" : JSON.stringify(fk)}`);
  console.log(`  file size: ${mb(sizeBefore)} -> ${mb(sizeAfter)} (${sizeAfter - sizeBefore >= 0 ? "+" : ""}${mb(sizeAfter - sizeBefore)})`);
  for (const t of TABLES) console.log(`  ${t}: ${before[t].toLocaleString()} -> ${after[t].toLocaleString()}`);
  console.log(`compactDb: done ${new Date().toISOString()}`);

  if (integrity[0].integrity_check !== "ok" || fk.length > 0) {
    console.error("compactDb: VERIFICATION FAILED — see output above");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("compactDb: FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
