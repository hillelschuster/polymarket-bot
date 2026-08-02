// Job: report:daily. End-of-day DailyReport -> Telegram. SPEC §10,§12.
import { prisma } from "../lib/db.js";
import { compareStrategies, type BenchmarkTrade } from "../lib/benchmark.js";
import { sendMessage } from "../adapters/telegram.js";
import { config } from "../lib/config.js";
import { summarizePnl } from "../lib/reporting.js";

export async function runReportDaily(): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const allPaperTrades = await prisma.paperTrade.findMany({
    select: { id: true, source: true, status: true, realizedPnl: true, unrealizedPnl: true, marketId: true, walletAddress: true },
  });
  const openTrades = allPaperTrades.filter((trade) => trade.status === "open");
  const openPositions = openTrades.length;
  const winningPositions = openTrades.filter((t) => (t.unrealizedPnl ?? 0) > 0).length;
  const totalUnrealized = openTrades.reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);
  const resolved = allPaperTrades.filter((trade) => trade.status === "resolved");
  const resolvedWalletCopy = resolved.filter((trade) => trade.source === "wallet_copy");
  const pnl = summarizePnl(allPaperTrades);
  const totalPnl = pnl.combinedAccountingTotal;
  const wins = pnl.resolvedWalletCopyWins;
  const winRate = pnl.resolvedWalletCopyWinRate;

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

  const bestResolved = [...resolvedWalletCopy].sort((a, b) => (b.realizedPnl ?? 0) - (a.realizedPnl ?? 0)).slice(0, 3);
  const worstResolved = [...resolvedWalletCopy].sort((a, b) => (a.realizedPnl ?? 0) - (b.realizedPnl ?? 0)).slice(0, 3);

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
      resolvedWalletCopyPnl: pnl.resolvedWalletCopyPnl,
      resolvedStrategyPnl: pnl.resolvedStrategyPnl,
      legacyClosedStopLossPnl: pnl.legacyClosedStopLossPnl,
      openWalletCopyUnrealizedPnl: pnl.openWalletCopyUnrealizedPnl,
      openStrategyUnrealizedPnl: pnl.openStrategyUnrealizedPnl,
      combinedAccountingTotal: pnl.combinedAccountingTotal,
      resolvedWalletCopyWinRate: pnl.resolvedWalletCopyWinRate,
      summary: `Resolved wallet-copy: $${pnl.resolvedWalletCopyPnl.toFixed(2)} | WR: ${wins}/${pnl.resolvedWalletCopyCount} (${(winRate * 100).toFixed(1)}%) | Resolved strategy: $${pnl.resolvedStrategyPnl.toFixed(2)} | Legacy closed stop-loss: $${pnl.legacyClosedStopLossPnl.toFixed(2)} | Open wallet-copy unrealized: $${pnl.openWalletCopyUnrealizedPnl.toFixed(2)} | Open strategy unrealized: $${pnl.openStrategyUnrealizedPnl.toFixed(2)} | Combined accounting total (includes legacy losses): $${pnl.combinedAccountingTotal.toFixed(2)} | BeatBlind: ${beatBlindCopy === null ? 'N/A' : beatBlindCopy}`,
    },
    update: {},
  });

  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    const msg = `<b>Daily Report</b>\nResolved wallet-copy: $${pnl.resolvedWalletCopyPnl.toFixed(2)} | WR ${wins}/${pnl.resolvedWalletCopyCount} (${(winRate * 100).toFixed(1)}%)\nResolved strategy: $${pnl.resolvedStrategyPnl.toFixed(2)}\nLegacy closed stop-loss: $${pnl.legacyClosedStopLossPnl.toFixed(2)}\nOpen wallet-copy unrealized: $${pnl.openWalletCopyUnrealizedPnl.toFixed(2)}\nOpen strategy unrealized: $${pnl.openStrategyUnrealizedPnl.toFixed(2)}\nCombined accounting total (includes legacy losses): $${pnl.combinedAccountingTotal.toFixed(2)}\nOpen: ${openPositions} (in profit: ${winningPositions})\nCopied: ${copied}\nBeatBlind: ${beatBlindCopy === null ? 'N/A' : beatBlindCopy}`;
    await sendMessage(msg);
    await prisma.dailyReport.update({ where: { id: report.id }, data: { sentToTelegram: true } });
  }
  console.log(`reportDaily done: walletCopyResolved=$${pnl.resolvedWalletCopyPnl.toFixed(2)} (WR=${wins}/${pnl.resolvedWalletCopyCount}, ${(winRate * 100).toFixed(1)}%) | strategyResolved=$${pnl.resolvedStrategyPnl.toFixed(2)} | legacyClosedSL=$${pnl.legacyClosedStopLossPnl.toFixed(2)} | openWalletCopyUnrealized=$${pnl.openWalletCopyUnrealizedPnl.toFixed(2)} | openStrategyUnrealized=$${pnl.openStrategyUnrealizedPnl.toFixed(2)} | combinedAccountingIncludingLegacy=$${pnl.combinedAccountingTotal.toFixed(2)} | Open=${openPositions} (profit:${winningPositions})`);
}

if (require.main === module) runReportDaily().catch(console.error);
