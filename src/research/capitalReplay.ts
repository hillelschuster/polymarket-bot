/**
 * RESEARCH MODULE — Capital-Constrained Replay
 * 
 * Reads all paper trades chronologically and simulates a $300 bankroll
 * with realistic capital constraints. Reports ROI, drawdown, utilization.
 * READ-ONLY — does not modify the main pipeline or database.
 * 
 * Usage: npx tsx src/research/capitalReplay.ts
 */
import { prisma } from "../lib/db.js";

const STARTING_BANKROLL = 300;
const MAX_DEPLOYED_PCT = 0.70; // 70% max deployed
const MAX_PER_TRADE_PCT = 0.10; // 10% max per trade
const MAX_PER_EVENT_PCT = 0.10; // 10% max per event (slug)

interface ReplayTrade {
  id: string;
  slug: string | null;
  walletAddress: string;
  entryPrice: number | null;
  simulatedPositionSize: number | null;
  openedAt: Date;
  status: string;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
}

interface CapitalEvent {
  time: Date;
  type: "deploy" | "recycle";
  amount: number;
  slug: string;
  wallet: string;
  bankrollAfter: number;
  deployedAfter: number;
}

async function main() {
  console.log(`=== CAPITAL-CONSTRAINED REPLAY: $${STARTING_BANKROLL} ===\n`);

  // Get all wallet-copy paper trades chronologically
  const trades = await prisma.paperTrade.findMany({
    where: { source: "wallet_copy" },
    orderBy: { openedAt: "asc" },
    select: {
      id: true, slug: true, walletAddress: true, entryPrice: true,
      simulatedPositionSize: true, openedAt: true, status: true,
      realizedPnl: true, unrealizedPnl: true, resolvedAt: true, closedAt: true,
    },
  });

  if (!trades.length) {
    console.log("No wallet-copy trades found.");
    return;
  }

  console.log(`Total trades: ${trades.length}`);
  console.log(`Date range: ${trades[0].openedAt.toISOString().slice(0, 10)} → ${trades[trades.length - 1].openedAt.toISOString().slice(0, 10)}\n`);

  // Simulate
  let bankroll = STARTING_BANKROLL;
  let deployed = 0;
  let peakBankroll = STARTING_BANKROLL;
  let maxDrawdown = 0;
  let skippedNoCapital = 0;
  let skippedMaxEvent = 0;
  let acceptedTrades = 0;
  let totalPnl = 0;
  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;

  const events: CapitalEvent[] = [];
  const openPositions = new Map<string, { size: number; slug: string }>(); // tradeId → {size, slug}
  const eventExposure = new Map<string, number>(); // slug → deployed amount

  // Process trades chronologically
  for (const trade of trades) {
    const entryPrice = trade.entryPrice ?? 0.5;
    const slug = trade.slug ?? "unknown";
    const wallet = trade.walletAddress.slice(0, 10);

    // First: recycle any capital from trades resolved BEFORE this one opened
    for (const [openId, pos] of [...openPositions.entries()]) {
      const openTrade = trades.find((t) => t.id === openId);
      if (!openTrade) continue;
      const endTime = openTrade.resolvedAt ?? openTrade.closedAt;
      if (endTime && endTime < trade.openedAt) {
        // Recycle capital
        const pnl = openTrade.status === "resolved" ? (openTrade.realizedPnl ?? 0) : (openTrade.realizedPnl ?? 0);
        const recycled = pos.size + pnl;
        bankroll += Math.max(0, recycled);
        deployed -= pos.size;
        const slugExposure = eventExposure.get(pos.slug) ?? 0;
        eventExposure.set(pos.slug, Math.max(0, slugExposure - pos.size));
        openPositions.delete(openId);
        events.push({ time: endTime, type: "recycle", amount: recycled, slug: pos.slug, wallet: "", bankrollAfter: bankroll, deployedAfter: deployed });
      }
    }

    // Determine position size (use the paper trade's actual size, capped by bankroll %)
    let size = trade.simulatedPositionSize ?? 10;
    const maxTrade = bankroll * MAX_PER_TRADE_PCT;
    const maxDeployed = STARTING_BANKROLL * MAX_DEPLOYED_PCT;
    const maxEvent = STARTING_BANKROLL * MAX_PER_EVENT_PCT;

    // Check capital constraints
    const currentEventExposure = eventExposure.get(slug) ?? 0;
    if (deployed + size > maxDeployed) {
      size = Math.max(0, maxDeployed - deployed);
      if (size < 3) { // minimum viable trade
        skippedNoCapital++;
        continue;
      }
    }
    if (currentEventExposure + size > maxEvent) {
      size = Math.max(0, maxEvent - currentEventExposure);
      if (size < 3) {
        skippedMaxEvent++;
        continue;
      }
    }
    if (size > bankroll * MAX_PER_TRADE_PCT) {
      size = bankroll * MAX_PER_TRADE_PCT;
    }
    if (size < 3) {
      skippedNoCapital++;
      continue;
    }

    // Deploy
    size = Math.round(size * 100) / 100;
    bankroll -= size;
    deployed += size;
    eventExposure.set(slug, currentEventExposure + size);
    openPositions.set(trade.id, { size, slug });
    acceptedTrades++;
    events.push({ time: trade.openedAt, type: "deploy", amount: size, slug, wallet, bankrollAfter: bankroll, deployedAfter: deployed });
  }

  // Final: resolve all remaining open positions at their current marks
  for (const [openId, pos] of openPositions.entries()) {
    const openTrade = trades.find((t) => t.id === openId);
    if (!openTrade) continue;
    const pnl = openTrade.status === "open" ? (openTrade.unrealizedPnl ?? 0) : (openTrade.realizedPnl ?? 0);
    const recycled = pos.size + pnl;
    bankroll += Math.max(0, recycled);
    deployed -= pos.size;
    totalPnl += pnl;
    if (pnl > 0) wins++;
    else losses++;
    if (openTrade.status === "resolved") realizedPnl += (openTrade.realizedPnl ?? 0);
  }

  // Also count PnL from trades that were recycled during the simulation
  for (const trade of trades) {
    if ((trade.resolvedAt ?? trade.closedAt) && trade.status !== "open") {
      const pnl = trade.realizedPnl ?? 0;
      totalPnl += pnl;
      if (pnl > 0) wins++;
      else losses++;
      realizedPnl += pnl;
    }
  }

  // Compute drawdown from events
  let runningValue = STARTING_BANKROLL;
  peakBankroll = STARTING_BANKROLL;
  for (const ev of events) {
    runningValue = ev.bankrollAfter + ev.deployedAfter;
    if (runningValue > peakBankroll) peakBankroll = runningValue;
    const dd = (peakBankroll - runningValue) / peakBankroll;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const finalValue = bankroll + deployed;
  const roi = ((finalValue - STARTING_BANKROLL) / STARTING_BANKROLL * 100);

  console.log("=== RESULTS ===");
  console.log(`Starting bankroll:     $${STARTING_BANKROLL.toFixed(2)}`);
  console.log(`Final value:           $${finalValue.toFixed(2)} (cash $${bankroll.toFixed(2)} + deployed $${deployed.toFixed(2)})`);
  console.log(`Net PnL:               $${(finalValue - STARTING_BANKROLL).toFixed(2)}`);
  console.log(`ROI on bankroll:       ${roi.toFixed(2)}%`);
  console.log(`Realized PnL:          $${realizedPnl.toFixed(2)}`);
  console.log(`Max drawdown:          ${(maxDrawdown * 100).toFixed(2)}%`);
  console.log(`Peak value:            $${peakBankroll.toFixed(2)}`);
  console.log(`\nTrades accepted:       ${acceptedTrades}`);
  console.log(`Trades skipped (capital): ${skippedNoCapital}`);
  console.log(`Trades skipped (event cap): ${skippedMaxEvent}`);
  console.log(`Wins / Losses:         ${wins} / ${losses} (${wins + losses > 0 ? Math.round(wins / (wins + losses) * 100) : 0}% win)`);
  console.log(`Capital utilization:   ${(deployed / STARTING_BANKROLL * 100).toFixed(1)}% currently deployed`);

  // Per-wallet breakdown
  console.log("\n=== PER-WALLET (accepted trades) ===");
  const walletPnl = new Map<string, { count: number; pnl: number; deployed: number }>();
  for (const ev of events.filter((e) => e.type === "deploy")) {
    const e = walletPnl.get(ev.wallet) ?? { count: 0, pnl: 0, deployed: 0 };
    e.count++;
    e.deployed += ev.amount;
    walletPnl.set(ev.wallet, e);
  }
  for (const [w, e] of [...walletPnl.entries()].sort((a, b) => b[1].deployed - a[1].deployed)) {
    console.log(`  ${w}... ${e.count} trades, $${e.deployed.toFixed(2)} deployed`);
  }

  // Timeline
  console.log("\n=== CAPITAL TIMELINE (first 20 events) ===");
  for (const ev of events.slice(0, 20)) {
    const time = ev.time.toISOString().slice(5, 16).replace("T", " ");
    const action = ev.type === "deploy" ? `DEPLOY $${ev.amount.toFixed(2)}` : `RECYCLE $${ev.amount.toFixed(2)}`;
    console.log(`  ${time} | ${action.padEnd(16)} | ${ev.slug.slice(0, 30).padEnd(30)} | cash=$${ev.bankrollAfter.toFixed(0)} deployed=$${ev.deployedAfter.toFixed(0)}`);
  }
}

main().catch(console.error);
