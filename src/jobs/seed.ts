// Seed: deterministic DEMO data for local dev. Labeled clearly (0xDEMO...). SPEC §14.
import { prisma } from "../lib/db.js";
import { DEFAULT_RULES } from "../lib/scoring.js";

let _counter = 0;
function seedInt(lo: number, hi: number): number {
  // Deterministic "seeded" value from a counter
  _counter = (_counter + 1) % 1000;
  return lo + (_counter % (hi - lo + 1));
}
function seedFloat(lo: number, hi: number, dec = 2): number {
  const v = lo + ((_counter * 7.31 + 13.7) % (hi - lo + 0.001));
  _counter = (_counter + 1) % 1000;
  return Math.round(v * 10 ** dec) / 10 ** dec;
}

const DECISIONS = ["paper_copy", "watchlist", "skip"] as const;
const STATUSES = ["open", "resolved"] as const;
const WALLET_ADDRS = Array.from({ length: 12 }, (_, i) => `0xDEMO${String(i + 1).padStart(4, "0")}`);

export async function runSeed(): Promise<void> {
  // 1. LeaderboardScan
  const scan = await prisma.leaderboardScan.create({
    data: {
      source: "DEMO",
      scannedAt: new Date(),
      walletCount: 12,
      lookbackDays: 30,
      rawSummaryJson: JSON.stringify({ demo: true }),
    },
  });
  console.log(`  scan ${scan.id}`);

  // 2. WalletProfiles
  const walletIds: string[] = [];
  for (let i = 0; i < 12; i++) {
    const addr = WALLET_ADDRS[i];
    const w = await prisma.walletProfile.upsert({
      where: { address: addr },
      create: {
        address: addr,
        label: `DEMO Trader ${i + 1}`,
        sourceRank: i + 1,
        status: i < 5 ? "track" : "watch",
        roi30d: seedFloat(-0.3, 1.5, 4),
        winRate30d: seedFloat(0.3, 0.85, 3),
        resolvedTradeCount30d: seedInt(2, 30),
        tradeCount30d: seedInt(5, 80),
        averageLiquidity: seedFloat(5_000, 200_000, 0),
        averageSpread: seedFloat(0.01, 0.08, 4),
        averageEntryTiming: seedFloat(0.01, 0.5, 3),
        globalScore: seedFloat(30, 95, 1),
        scoreComponentsJson: JSON.stringify({
          roiScore: seedFloat(20, 95, 1),
          consistency: seedFloat(30, 90, 1),
          copyability: seedFloat(25, 85, 1),
          categoryEdge: seedFloat(40, 100, 1),
          oneHitPenalty: i % 3 === 0 ? 15 : 0,
          illiquidPenalty: i % 4 === 0 ? 10 : 0,
        }),
        bestCategory: ["Sports", "Politics", "Crypto", "Weather", "Science"][i % 5],
        categoryStrengthsJson: JSON.stringify({ Sports: 80, Politics: 60, Crypto: 90 }),
        scanId: scan.id,
        lastScannedAt: new Date(),
      },
      update: {},
    });
    walletIds.push(w.id);
  }
  console.log(`  12 wallets`);

  // 3. ObservedTrades ~30
  const tradeIds: string[] = [];
  for (let i = 0; i < 30; i++) {
    const addr = WALLET_ADDRS[i % 12];
    const t = await prisma.observedTrade.create({
      data: {
        walletAddress: addr,
        marketId: `DEMO_MARKET_${(i % 10) + 1}`,
        conditionId: `DEMO_COND_${i}`,
        marketQuestion: `DEMO: Will event ${(i % 10) + 1} happen?`,
        marketCategory: ["Sports", "Politics", "Crypto"][i % 3],
        outcome: i % 2 === 0 ? "YES" : "NO",
        side: i % 2 === 0 ? "BUY" : "SELL",
        walletEntryPrice: seedFloat(0.1, 0.9, 4),
        detectedPrice: seedFloat(0.1, 0.9, 4),
        size: seedFloat(10, 5000, 2),
        timestamp: new Date(Date.now() - i * 3600_000),
        rawTradeJson: JSON.stringify({ demo: true, index: i }),
      },
    });
    tradeIds.push(t.id);
  }
  console.log(`  30 trades`);

  // 4. DecisionJournals ~20
  const djIds: string[] = [];
  for (let i = 0; i < 20; i++) {
    const dec = DECISIONS[i % 3];
    const dj = await prisma.decisionJournal.create({
      data: {
        observedTradeId: tradeIds[i],
        walletAddress: WALLET_ADDRS[i % 12],
        marketId: `DEMO_MARKET_${(i % 10) + 1}`,
        decision: dec,
        copyScore: seedFloat(30, 95, 1),
        confidence: dec === "paper_copy" ? seedFloat(0.5, 0.95, 2) : null,
        reasonsJson: JSON.stringify([`seed score OK`, `demo reason ${i}`]),
        walletQualityScore: seedFloat(40, 90, 1),
        roiScore: seedFloat(30, 90, 1),
        consistencyScore: seedFloat(30, 85, 1),
        copyabilityScore: seedFloat(30, 80, 1),
        categoryFitScore: seedFloat(0, 100, 1),
        entryTimingScore: seedFloat(40, 90, 1),
        spreadScore: seedFloat(30, 90, 1),
        liquidityScore: seedFloat(30, 90, 1),
        thesisScore: seedFloat(40, 90, 1),
        simulatedPositionSize: dec === "paper_copy" ? seedFloat(5, 20, 2) : null,
      },
    });
    djIds.push(dj.id);
  }
  console.log(`  20 decision journals`);

  // 5. PaperTrades ~10 (mix open/resolved)
  const ptIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const status = i < 4 ? "open" : "resolved";
    const entryPrice = seedFloat(0.2, 0.8, 4);
    const currentPrice = status === "resolved" ? (i % 2 === 0 ? 1 : 0) : seedFloat(0.15, 0.9, 4);
    const realizedPnl = status === "resolved" ? seedFloat(-12, 18, 2) : null;
    const pt = await prisma.paperTrade.create({
      data: {
        decisionJournalId: djIds[i],
        walletAddress: WALLET_ADDRS[i % 12],
        marketId: `DEMO_MARKET_${(i % 10) + 1}`,
        outcome: i % 2 === 0 ? "YES" : "NO",
        side: i % 2 === 0 ? "BUY" : "SELL",
        entryPrice,
        currentPrice,
        simulatedPositionSize: seedFloat(5, 20, 2),
        unrealizedPnl: status === "open" ? seedFloat(-5, 8, 2) : 0,
        realizedPnl,
        status,
        openedAt: new Date(Date.now() - (20 - i) * 3600_000),
        closedAt: status === "resolved" ? new Date() : null,
        resolvedAt: status === "resolved" ? new Date() : null,
      },
    });
    ptIds.push(pt.id);
  }
  console.log(`  10 paper trades`);

  // 6. PnlSnapshots ~40
  for (let i = 0; i < 40; i++) {
    await prisma.pnlSnapshot.create({
      data: {
        paperTradeId: ptIds[i % 10],
        price: seedFloat(0.1, 0.95, 4),
        pnl: seedFloat(-5, 10, 2),
        collectedAt: new Date(Date.now() - i * 1800_000),
      },
    });
  }
  console.log(`  40 pnl snapshots`);

  // 7. OutcomeReviews ~8
  for (let i = 0; i < 8; i++) {
    await prisma.outcomeReview.create({
      data: {
        decisionJournalId: djIds[i + 10], // use DJs beyond the first 10
        paperTradeId: ptIds[i],
        finalOutcome: i % 2 === 0 ? 1 : 0,
        simulatedPnl: seedFloat(-12, 18, 2),
        wasDecisionGood: i % 3 !== 0,
        priceAfter1h: seedFloat(0.1, 0.9, 4),
        priceAfter6h: seedFloat(0.1, 0.9, 4),
        priceAfter24h: seedFloat(0, 1, 4),
        lessonsJson: JSON.stringify(["demo lesson: check spread before entry"]),
      },
    });
  }
  console.log(`  8 outcome reviews`);

  // 8. RuleSet + RuleChanges
  const ruleset1 = await prisma.ruleSet.create({
    data: { version: 1, active: false, rulesJson: JSON.stringify(DEFAULT_RULES) },
  });
  const ruleset2 = await prisma.ruleSet.create({
    data: {
      version: 2,
      active: true,
      rulesJson: JSON.stringify({ ...DEFAULT_RULES, maxSpread: 0.04, minLiquidity: 12_000 }),
    },
  });
  await prisma.ruleChange.create({
    data: {
      oldRuleSetId: ruleset1.id,
      newRuleSetId: ruleset2.id,
      changedBy: "auto",
      reason: "DEMO: tightened spread due to losses",
      evidenceSummary: '{"spreadHeavyLossPnL":-20}',
      beforeJson: JSON.stringify(DEFAULT_RULES),
      afterJson: JSON.stringify({ ...DEFAULT_RULES, maxSpread: 0.04, minLiquidity: 12_000 }),
    },
  });
  await prisma.ruleChange.create({
    data: {
      oldRuleSetId: ruleset1.id,
      newRuleSetId: ruleset2.id,
      changedBy: "auto",
      reason: "DEMO: raised liquidity floor",
      evidenceSummary: '{"lowLiquidityLossPnL":-15}',
      beforeJson: JSON.stringify({ ...DEFAULT_RULES, maxSpread: 0.04, minLiquidity: 12_000 }),
      afterJson: JSON.stringify({ ...DEFAULT_RULES, maxSpread: 0.04, minLiquidity: 12_000 }),
    },
  });
  console.log(`  rule sets + 2 changes`);

  // 9. DailyReport
  await prisma.dailyReport.create({
    data: {
      date: new Date(),
      paperPnl: 42.5,
      winRate: 0.6,
      openPositions: 4,
      newSignals: 20,
      copiedSignals: 6,
      watchedSignals: 8,
      skippedSignals: 6,
      bestWalletsJson: JSON.stringify([{ address: WALLET_ADDRS[0], pnl: 18.5 }]),
      worstWalletsJson: JSON.stringify([{ address: WALLET_ADDRS[3], pnl: -8.2 }]),
      ruleChangesJson: JSON.stringify([{ id: "DEMO_RC", reason: "DEMO: spread tightening" }]),
      summary: "DEMO daily report — seed data, no live execution.",
    },
  });
  console.log(`  1 daily report`);

  console.log("Seed complete: labeled DEMO data inserted.");
}

if (require.main === module) runSeed().catch(console.error);
