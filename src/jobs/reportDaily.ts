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
  const closedSL = await prisma.paperTrade.findMany({ where: { status: "closed" } });
  const resolvedPnl = resolved.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  const stopLossPnl = closedSL.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  const totalPnl = resolvedPnl + stopLossPnl; // net realized (resolved + stop-lossed)
  const wins = resolved.filter((t) => (t.realizedPnl ?? 0) > 0).length;
  const winRate = resolved.length ? wins / resolved.length : 0;

  const journals = await prisma.decisionJournal.findMany({ take: 100 });
  const copied = journals.filter((j) => j.decision === "paper_copy").length;
  const watched = journals.filter((j) => j.decision === "watchlist").length;
  const skipped = journals.filter((j) => j.decision === "skip").length;

  // Benchmark: bot-filtered trades vs blind-copy baseline.
  // Bot trades = resolved PaperTrades (passed our filters).
  // Blind baseline = ALL observed trades that we could have copied (no filtering).
  // This gives a fair comparison: did our filtering add value vs random copying?
  const bmTrades: BenchmarkTrade[] = resolved.map((t) => ({
    id: t.id,
    strategy: "bot" as const,
    pnl: t.realizedPnl ?? 0,
    marketId: t.marketId,
    walletAddress: t.walletAddress,
  }));

  // Blind-copy baseline: simulate copying ALL observed trades from tracked wallets
  // without any filtering. Uses the same PnL formula as bot trades for fair comparison.
  // This answers: "Would we have done better/worse by copying everything?"
  //
  // Note: ObservedTrade doesn't have a direct relation to MarketSnapshot,
  // so we query resolved snapshots first, then find observed trades for those markets.
  const resolvedSnapshots = await prisma.marketSnapshot.findMany({
    where: {
      OR: [
        { yesPrice: { gte: 0.995 } },
        { yesPrice: { lte: 0.005 } },
      ],
    },
    take: 200,
  });

  const resolvedMarketIds = new Set(resolvedSnapshots.map((s) => s.marketId));
  const snapshotByMarket = new Map(resolvedSnapshots.map((s) => [s.marketId, s]));

  const observedTrades = await prisma.observedTrade.findMany({
    where: {
      marketId: { in: [...resolvedMarketIds] },
    },
    take: 200,
  });

  for (const ot of observedTrades) {
    // Skip if this trade was already copied by the bot (avoid double-counting)
    const wasCopied = resolved.some((pt) => pt.marketId === ot.marketId);
    if (wasCopied) continue;

    // Calculate what PnL would have been if we blindly copied this trade
    const snap = snapshotByMarket.get(ot.marketId);
    if (!snap || snap.yesPrice == null) continue;

    const entryPrice = ot.detectedPrice ?? ot.walletEntryPrice ?? 0.5;
    const side = (ot.side ?? "BUY").toUpperCase();
    const size = 10; // Standard $10 position for fair comparison

    // Determine if this trade would have won
    const yesFinal = snap.yesPrice;
    const isResolved = yesFinal >= 0.995 || yesFinal <= 0.005;
    if (!isResolved) continue;

    // Calculate PnL using the same formula as paper.ts
    const shares = size / entryPrice;
    let pnl: number;
    if (side === "BUY" || side === "YES") {
      // BUY wins if YES resolves to 1
      const won = yesFinal >= 0.995;
      pnl = won ? shares * (1 - entryPrice) : shares * (0 - entryPrice);
    } else {
      // SELL/NO wins if YES resolves to 0
      const won = yesFinal <= 0.005;
      pnl = won ? shares * (entryPrice - 0) : shares * (entryPrice - 1);
    }

    bmTrades.push({
      id: `blind-${ot.id}`,
      strategy: "blind",
      pnl: Math.round(pnl * 100) / 100,
      marketId: ot.marketId,
      walletAddress: ot.walletAddress,
    });
  }

  const benchmark = compareStrategies(bmTrades);
  // BeatBlind is only meaningful when we have blind trades to compare against
  const beatBlindCopy = benchmark.blindCopy.count > 0
    ? benchmark.botFiltered.netPnl >= benchmark.blindCopy.netPnl
    : null; // null = insufficient data for comparison

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
      summary: `Net Realized: $${totalPnl.toFixed(2)} (resolved $${resolvedPnl.toFixed(2)} | stop-loss $${stopLossPnl.toFixed(2)}) | Unrealized: $${totalUnrealized.toFixed(2)} | Resolved WinRate: ${wins}/${resolved.length} (${(winRate * 100).toFixed(1)}%) | Open: ${openPositions} (in profit: ${winningPositions}) | BeatBlind: ${beatBlindCopy === null ? 'N/A' : beatBlindCopy}`,
    },
    update: {},
  });

  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    const msg = `<b>Daily Report</b>\nNet Realized: $${totalPnl.toFixed(2)} (resolved $${resolvedPnl.toFixed(2)} | SL $${stopLossPnl.toFixed(2)})\nUnrealized: $${totalUnrealized.toFixed(2)}\nResolved WinRate: ${wins}/${resolved.length} (${(winRate * 100).toFixed(1)}%)\nOpen: ${openPositions} (in profit: ${winningPositions})\nCopied: ${copied}\nBeatBlind: ${beatBlindCopy === null ? 'N/A' : beatBlindCopy}`;
    await sendMessage(msg);
    await prisma.dailyReport.update({ where: { id: report.id }, data: { sentToTelegram: true } });
  }
  console.log(`reportDaily done: NetRealized=$${totalPnl.toFixed(2)} (resolved=$${resolvedPnl.toFixed(2)} SL=$${stopLossPnl.toFixed(2)}) | Unrealized=$${totalUnrealized.toFixed(2)} | WinRate=${wins}/${resolved.length} (${(winRate * 100).toFixed(1)}%) | Open=${openPositions} (profit:${winningPositions})`);
}

if (require.main === module) runReportDaily().catch(console.error);
