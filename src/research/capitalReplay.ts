/**
 * RESEARCH MODULE — Capital-Constrained Replay
 * READ-ONLY: replays wallet-copy paper trades against a constrained bankroll.
 * Usage: npx tsx src/research/capitalReplay.ts
 */
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { prisma } from "../lib/db.js";

const STARTING_BANKROLL = 300;
const MAX_DEPLOYED_PCT = 0.70;
const MAX_PER_TRADE_PCT = 0.10;
const MAX_PER_EVENT_PCT = 0.10;
const MIN_TRADE_USD = 3;
const EPSILON = 0.005;

interface ReplayTrade {
  id: string;
  slug: string | null;
  marketId: string;
  walletAddress: string;
  simulatedPositionSize: number | null;
  openedAt: Date;
  status: string;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  pnlSnapshots: { pnl: number | null; collectedAt: Date }[];
}

interface PositionState {
  trade: ReplayTrade;
  stake: number;
  scale: number;
  eventKey: string;
  markedPnl: number;
  currentValue: number;
}

type ReplayEvent =
  | { time: Date; priority: 0; type: "exit"; tradeId: string }
  | { time: Date; priority: 1; type: "mark"; tradeId: string; pnl: number }
  | { time: Date; priority: 2; type: "open"; tradeId: string };

export interface ReplayWalletStat {
  walletAddress: string;
  accepted: number;
  resolved: number;
  deployed: number;
  pnl: number;
}

export interface CapitalReplayResult {
  generatedAt: string;
  startingBankroll: number;
  finalEquity: number;
  cash: number;
  openMarketValue: number;
  netPnl: number;
  roiPct: number;
  realizedPnl: number;
  unrealizedPnl: number;
  maxDrawdownPct: number;
  peakEquity: number;
  averageUtilizationPct: number;
  peakUtilizationPct: number;
  acceptedTrades: number;
  acceptedFinalizedTrades: number;
  acceptedResolvedTrades: number;
  acceptedClosedTrades: number;
  acceptedOpenTrades: number;
  skippedNoCapital: number;
  skippedEventCap: number;
  skippedInvalid: number;
  wins: number;
  losses: number;
  scratches: number;
  winRate: number;
  snapshotCoveragePct: number;
  payoutAnomalies: number;
  walletStats: ReplayWalletStat[];
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function terminalTime(trade: ReplayTrade): Date | null {
  const times = [trade.closedAt, trade.resolvedAt].filter((value): value is Date => value != null);
  if (!times.length) return null;
  return new Date(Math.min(...times.map((value) => value.getTime())));
}

function originalStake(trade: ReplayTrade): number {
  const value = Number(trade.simulatedPositionSize);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function runCapitalReplay(): Promise<CapitalReplayResult> {
  const trades = await prisma.paperTrade.findMany({
    where: { source: "wallet_copy" },
    orderBy: { openedAt: "asc" },
    select: {
      id: true,
      slug: true,
      marketId: true,
      walletAddress: true,
      simulatedPositionSize: true,
      openedAt: true,
      status: true,
      realizedPnl: true,
      unrealizedPnl: true,
      resolvedAt: true,
      closedAt: true,
      pnlSnapshots: {
        orderBy: { collectedAt: "asc" },
        select: { pnl: true, collectedAt: true },
      },
    },
  }) as ReplayTrade[];

  const now = new Date();
  const tradeById = new Map(trades.map((trade) => [trade.id, trade]));
  const events: ReplayEvent[] = [];
  let tradesWithSnapshots = 0;

  for (const trade of trades) {
    events.push({ time: trade.openedAt, priority: 2, type: "open", tradeId: trade.id });
    const endTime = terminalTime(trade);
    const boundedSnapshots = trade.pnlSnapshots.filter((snapshot) => {
      if (!Number.isFinite(Number(snapshot.pnl))) return false;
      return snapshot.collectedAt >= trade.openedAt && (!endTime || snapshot.collectedAt <= endTime);
    });
    if (boundedSnapshots.length) tradesWithSnapshots++;
    for (const snapshot of boundedSnapshots) {
      events.push({
        time: snapshot.collectedAt,
        priority: 1,
        type: "mark",
        tradeId: trade.id,
        pnl: Number(snapshot.pnl),
      });
    }
    if (endTime) {
      events.push({ time: endTime, priority: 0, type: "exit", tradeId: trade.id });
    } else {
      events.push({
        time: now,
        priority: 1,
        type: "mark",
        tradeId: trade.id,
        pnl: Number(trade.unrealizedPnl) || 0,
      });
    }
  }

  events.sort((a, b) => a.time.getTime() - b.time.getTime() || a.priority - b.priority);

  let cash = STARTING_BANKROLL;
  let realizedPnl = 0;
  let skippedNoCapital = 0;
  let skippedEventCap = 0;
  let skippedInvalid = 0;
  let payoutAnomalies = 0;
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let acceptedFinalizedTrades = 0;
  let acceptedResolvedTrades = 0;
  let acceptedClosedTrades = 0;
  let peakEquity = STARTING_BANKROLL;
  let maxDrawdown = 0;
  let utilizationSamples = 0;
  let utilizationSum = 0;
  let peakUtilization = 0;

  const positions = new Map<string, PositionState>();
  const eventExposure = new Map<string, number>();
  const walletStats = new Map<string, ReplayWalletStat>();

  function deployedCost(): number {
    let value = 0;
    for (const position of positions.values()) value += position.stake;
    return value;
  }

  function openMarketValue(): number {
    let value = 0;
    for (const position of positions.values()) value += position.currentValue;
    return value;
  }

  function equity(): number {
    return cash + openMarketValue();
  }

  function sampleRiskState(): void {
    const currentEquity = equity();
    if (currentEquity > peakEquity) peakEquity = currentEquity;
    if (peakEquity > 0) maxDrawdown = Math.max(maxDrawdown, (peakEquity - currentEquity) / peakEquity);
    const utilization = currentEquity > 0 ? deployedCost() / currentEquity : 0;
    peakUtilization = Math.max(peakUtilization, utilization);
    utilizationSum += utilization;
    utilizationSamples++;
  }

  for (const event of events) {
    const trade = tradeById.get(event.tradeId);
    if (!trade) continue;

    if (event.type === "open") {
      const sourceStake = originalStake(trade);
      const endTime = terminalTime(trade);
      if (sourceStake <= 0 || (endTime != null && endTime.getTime() < trade.openedAt.getTime())) {
        skippedInvalid++;
        continue;
      }

      const currentEquity = equity();
      const currentDeployed = deployedCost();
      const eventKey = trade.slug ?? trade.marketId;
      const currentEventExposure = eventExposure.get(eventKey) ?? 0;
      const maxTrade = currentEquity * MAX_PER_TRADE_PCT;
      const maxDeployed = currentEquity * MAX_DEPLOYED_PCT;
      const maxEvent = currentEquity * MAX_PER_EVENT_PCT;
      const availableByPortfolio = Math.max(0, maxDeployed - currentDeployed);
      const availableByEvent = Math.max(0, maxEvent - currentEventExposure);
      const stake = round(Math.min(sourceStake, maxTrade, availableByPortfolio, availableByEvent, cash));

      if (stake < MIN_TRADE_USD) {
        if (availableByEvent < MIN_TRADE_USD) skippedEventCap++;
        else skippedNoCapital++;
        continue;
      }

      const scale = stake / sourceStake;
      positions.set(trade.id, {
        trade,
        stake,
        scale,
        eventKey,
        markedPnl: 0,
        currentValue: stake,
      });
      eventExposure.set(eventKey, currentEventExposure + stake);
      cash -= stake;

      const wallet = walletStats.get(trade.walletAddress) ?? {
        walletAddress: trade.walletAddress,
        accepted: 0,
        resolved: 0,
        deployed: 0,
        pnl: 0,
      };
      wallet.accepted++;
      wallet.deployed += stake;
      walletStats.set(trade.walletAddress, wallet);
      sampleRiskState();
      continue;
    }

    const position = positions.get(trade.id);
    if (!position) continue;

    if (event.type === "mark") {
      position.markedPnl = event.pnl * position.scale;
      position.currentValue = Math.max(0, position.stake + position.markedPnl);
      sampleRiskState();
      continue;
    }

    const rawPnl = (Number(trade.realizedPnl) || 0) * position.scale;
    const rawPayout = position.stake + rawPnl;
    if (rawPayout < -EPSILON) payoutAnomalies++;
    const payout = Math.max(0, rawPayout);
    const scaledPnl = payout - position.stake;
    cash += payout;
    realizedPnl += scaledPnl;
    acceptedFinalizedTrades++;
    if (trade.status === "resolved") acceptedResolvedTrades++;
    else acceptedClosedTrades++;
    if (scaledPnl > EPSILON) wins++;
    else if (scaledPnl < -EPSILON) losses++;
    else scratches++;

    const exposure = eventExposure.get(position.eventKey) ?? 0;
    eventExposure.set(position.eventKey, Math.max(0, exposure - position.stake));
    positions.delete(trade.id);

    const wallet = walletStats.get(trade.walletAddress);
    if (wallet) {
      wallet.resolved++;
      wallet.pnl += scaledPnl;
    }
    sampleRiskState();
  }

  const currentOpenValue = openMarketValue();
  const currentOpenCost = deployedCost();
  const unrealizedPnl = currentOpenValue - currentOpenCost;
  const finalEquity = cash + currentOpenValue;
  const acceptedTrades = [...walletStats.values()].reduce((sum, wallet) => sum + wallet.accepted, 0);
  const decisive = wins + losses;

  return {
    generatedAt: now.toISOString(),
    startingBankroll: STARTING_BANKROLL,
    finalEquity: round(finalEquity),
    cash: round(cash),
    openMarketValue: round(currentOpenValue),
    netPnl: round(finalEquity - STARTING_BANKROLL),
    roiPct: round((finalEquity - STARTING_BANKROLL) / STARTING_BANKROLL * 100),
    realizedPnl: round(realizedPnl),
    unrealizedPnl: round(unrealizedPnl),
    maxDrawdownPct: round(maxDrawdown * 100),
    peakEquity: round(peakEquity),
    averageUtilizationPct: round((utilizationSamples ? utilizationSum / utilizationSamples : 0) * 100),
    peakUtilizationPct: round(peakUtilization * 100),
    acceptedTrades,
    acceptedFinalizedTrades,
    acceptedResolvedTrades,
    acceptedClosedTrades,
    acceptedOpenTrades: positions.size,
    skippedNoCapital,
    skippedEventCap,
    skippedInvalid,
    wins,
    losses,
    scratches,
    winRate: decisive ? round(wins / decisive, 4) : 0,
    snapshotCoveragePct: trades.length ? round(tradesWithSnapshots / trades.length * 100) : 0,
    payoutAnomalies,
    walletStats: [...walletStats.values()]
      .map((wallet) => ({ ...wallet, deployed: round(wallet.deployed), pnl: round(wallet.pnl) }))
      .sort((a, b) => b.pnl - a.pnl),
  };
}

export function printCapitalReplay(result: CapitalReplayResult): void {
  console.log(`=== CAPITAL-CONSTRAINED REPLAY: $${result.startingBankroll} ===\n`);
  console.log(`Final equity:          $${result.finalEquity.toFixed(2)} (cash $${result.cash.toFixed(2)} + open value $${result.openMarketValue.toFixed(2)})`);
  console.log(`Net PnL / ROI:         $${result.netPnl.toFixed(2)} / ${result.roiPct.toFixed(2)}%`);
  console.log(`Realized / unrealized: $${result.realizedPnl.toFixed(2)} / $${result.unrealizedPnl.toFixed(2)}`);
  console.log(`Max drawdown:          ${result.maxDrawdownPct.toFixed(2)}%`);
  console.log(`Average / peak use:    ${result.averageUtilizationPct.toFixed(1)}% / ${result.peakUtilizationPct.toFixed(1)}%`);
  console.log(`Accepted:              ${result.acceptedTrades} (${result.acceptedResolvedTrades} resolved, ${result.acceptedClosedTrades} closed, ${result.acceptedOpenTrades} open)`);
  console.log(`Skipped:               ${result.skippedNoCapital} capital, ${result.skippedEventCap} event cap, ${result.skippedInvalid} invalid`);
  console.log(`Resolved W/L/S:        ${result.wins}/${result.losses}/${result.scratches} (${(result.winRate * 100).toFixed(0)}% decisive win rate)`);
  console.log(`Snapshot coverage:     ${result.snapshotCoveragePct.toFixed(1)}% of source trades`);
  if (result.payoutAnomalies) console.log(`Payout anomalies:      ${result.payoutAnomalies}`);

  console.log("\n=== PER WALLET ===");
  for (const wallet of result.walletStats.slice(0, 15)) {
    console.log(`  ${wallet.walletAddress.slice(0, 10)}... | ${wallet.accepted} accepted | ${wallet.resolved} resolved | $${wallet.pnl.toFixed(2)} PnL | $${wallet.deployed.toFixed(2)} deployed`);
  }
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectRun()) {
  runCapitalReplay()
    .then(printCapitalReplay)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
