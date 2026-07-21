// Job: report:daily. End-of-day DailyReport -> Telegram. SPEC §10,§12.
import { prisma } from "../lib/db.js";
import { compareStrategies, type BenchmarkTrade } from "../lib/benchmark.js";
import { sendMessage } from "../adapters/telegram.js";
import { config } from "../lib/config.js";

export async function runReportDaily(): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const openPositions = await prisma.paperTrade.count({ where: { status: "open" } });
  const openTrades = await prisma.paperTrade.findMany({ where: { status: "open" }, select: { unrealizedPnl: true } });
  const winningPositions = openTrades.filter((t) => (t.unrealizedPnl ?? 0) > 0).length;
  const totalUnrealized = openTrades.reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);
  const resolved = await prisma.paperTrade.findMany({ where: { status: "resolved" } });
  const totalPnl = resolved.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  const wins = resolved.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const winRate = resolved.length ? wins / resolved.length : 0;

  const journals = await prisma.decisionJournal.findMany({ take: 100 });
  const copied = journals.filter((j) => j.decision === "paper_copy").length;
  const watched = journals.filter((j) => j.decision === "watchlist").length;
  const skipped = journals.filter((j) => j.decision === "skip").length;

  // Benchmark: build from resolved trades
  const bmTrades: BenchmarkTrade[] = resolved.map((t) => ({
    id: t.id,
    strategy: "bot" as const,
    pnl: t.realizedPnl ?? 0,
    marketId: t.marketId,
    walletAddress: t.walletAddress,
  }));
  const benchmark = compareStrategies(bmTrades);
  const beatBlindCopy = benchmark.botFiltered.netPnl >= benchmark.blindCopy.netPnl;

  const bestResolved = resolved.sort((a, b) => (b.realizedPnl ?? 0) - (a.realizedPnl ?? 0)).slice(0, 3);
  const worstResolved = resolved.sort((a, b) => (a.realizedPnl ?? 0) - (b.realizedPnl ?? 0)).slice(0, 3);

  const ruleChanges = await prisma.ruleChange.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    include: { newRuleSet: true },
  });

  const report = await prisma.dailyReport.upsert({
    where: { date: today },
    create: {
      date: today,
      paperPnl: totalPnl,
      winRate,
      openPositions,
      newSignals: journals.length,
      copiedSignals: copied,
      watchedSignals: watched,
      skippedSignals: skipped,
      bestWalletsJson: JSON.stringify(bestResolved.map((t) => ({ address: t.walletAddress, pnl: t.realizedPnl }))),
      worstWalletsJson: JSON.stringify(worstResolved.map((t) => ({ address: t.walletAddress, pnl: t.realizedPnl }))),
      ruleChangesJson: JSON.stringify(ruleChanges.map((rc) => ({ id: rc.id, reason: rc.reason }))),
      winningPositions,
      unrealizedPnl: totalUnrealized,
      summary: `PnL: $${totalPnl.toFixed(2)} | Unrealized: $${totalUnrealized.toFixed(2)} | WinRate: ${(winRate * 100).toFixed(1)}% | Open: ${openPositions} | Winning: ${winningPositions} | BeatBlind: ${beatBlindCopy}`,
    },
    update: {},
  });

  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    const msg = `<b>Daily Report</b>\nPnL: $${totalPnl.toFixed(2)}\nUnrealized: $${totalUnrealized.toFixed(2)}\nWinRate: ${(winRate * 100).toFixed(1)}%\nOpen: ${openPositions}\nWinning: ${winningPositions}\nCopied: ${copied}\nBeatBlind: ${beatBlindCopy}`;
    await sendMessage(msg);
    await prisma.dailyReport.update({ where: { id: report.id }, data: { sentToTelegram: true } });
  }
  console.log(`reportDaily done: PnL=$${totalPnl.toFixed(2)} Unrealized=$${totalUnrealized.toFixed(2)} Winning=${winningPositions}/${openPositions} winRate=${(winRate * 100).toFixed(1)}%`);
}

if (require.main === module) runReportDaily().catch(console.error);
