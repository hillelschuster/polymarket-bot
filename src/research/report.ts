/**
 * Unified research report.
 * Usage: npx tsx src/research/report.ts
 */
import { prisma } from "../lib/db.js";
import { analyzeWalletIntel, type WalletIntelReport } from "./walletIntel.js";
import { runCapitalReplay, type CapitalReplayResult } from "./capitalReplay.js";
import { analyzeConsensus, type ConsensusResult } from "./consensusAnalysis.js";
import { loadLaneBLog, type ShadowLog } from "./laneBShadow.js";

const PILOT_RESOLVED_TARGET = 30;

function line(): void {
  console.log("-".repeat(92));
}

function walletSection(report: WalletIntelReport): void {
  console.log("\nWALLET TIERS");
  line();
  console.log(`A=${report.tierCounts.A} | B=${report.tierCounts.B} | C=${report.tierCounts.C} | DROP=${report.tierCounts.DROP} | API errors=${report.errors.length}`);
  const actionable = report.wallets.filter((wallet) => wallet.tier === "A" || wallet.tier === "B").slice(0, 10);
  for (const wallet of actionable) {
    const name = wallet.label ?? `${wallet.address.slice(0, 10)}...`;
    console.log(`${wallet.tier} ${name.padEnd(18)} score ${wallet.evidenceScore.toFixed(1).padStart(5)} | public ${wallet.closedSportsCount} / ${wallet.closedSportsRoi.toFixed(1)}% ROI | our ${wallet.ourResolvedCopyCount} / ${wallet.ourResolvedCopyRoi.toFixed(1)}% ROI`);
  }
  const drops = report.wallets.filter((wallet) => wallet.tier === "DROP");
  if (drops.length) console.log(`DROP now: ${drops.map((wallet) => wallet.label ?? wallet.address.slice(0, 10)).join(", ")}`);
}

function replaySection(result: CapitalReplayResult): void {
  console.log("\n$300 CAPITAL REPLAY");
  line();
  console.log(`Equity $${result.finalEquity.toFixed(2)} | PnL $${result.netPnl.toFixed(2)} | ROI ${result.roiPct.toFixed(2)}% | max DD ${result.maxDrawdownPct.toFixed(2)}%`);
  console.log(`Accepted ${result.acceptedTrades} | resolved ${result.acceptedResolvedTrades} | closed ${result.acceptedClosedTrades} | open ${result.acceptedOpenTrades} | skipped ${result.skippedNoCapital + result.skippedEventCap + result.skippedInvalid}`);
  console.log(`Resolved W/L/S ${result.wins}/${result.losses}/${result.scratches} | decisive win ${(result.winRate * 100).toFixed(0)}% | snapshots ${result.snapshotCoveragePct.toFixed(1)}%`);
  console.log(`Pilot validation gate: ${result.acceptedResolvedTrades}/${PILOT_RESOLVED_TARGET} resolved trades.`);
}

function consensusSection(result: ConsensusResult): void {
  console.log("\nCONSENSUS");
  line();
  console.log(`${result.primaryWindowMinutes}m consensus ${result.consensusEvents} | copied ${result.consensusCopied} | missed ${result.consensusMissed} | late agreements ${result.lateAgreementEvents}`);
  console.log(`Consensus resolved ${result.consensusResolvedCopies}: PnL $${result.consensusResolvedPnl.toFixed(2)}, win ${(result.consensusResolvedWinRate * 100).toFixed(0)}%`);
  console.log(`Solo resolved ${result.soloResolvedCopies}: PnL $${result.soloResolvedPnl.toFixed(2)}, win ${(result.soloResolvedWinRate * 100).toFixed(0)}%`);
  console.log(`Window sensitivity: ${result.sensitivity.map((item) => `${item.windowMinutes}m=${item.consensusEvents}`).join(" | ")} | scale-in campaigns ${result.scaleInCampaigns}`);
  const missed = result.campaigns.filter((campaign) => campaign.isConsensus && !campaign.hasCopy).slice(0, 5);
  for (const campaign of missed) {
    console.log(`MISSED ${campaign.slug.slice(0, 52).padEnd(52)} | ${campaign.walletCount} wallets | ${campaign.confirmationDelayMinutes?.toFixed(1)}m`);
  }
}

function laneBSection(log: ShadowLog): void {
  console.log("\nLANE B — POST-FINAL RESOLUTION LAG");
  line();
  console.log(`Detected ${log.stats.totalDetected} | active ${log.stats.active} | resolved ${log.stats.totalResolved} | W/L ${log.stats.wins}/${log.stats.losses} | invalid ${log.stats.invalidated}`);
  console.log(`Win ${(log.stats.winRate * 100).toFixed(0)}% | avg realized return ${(log.stats.avgRealizedReturn * 100).toFixed(2)}% | shadow PnL $${log.stats.totalShadowPnl.toFixed(2)}`);
  console.log(`Avg finish->detection ${log.stats.avgDetectionLagMinutes.toFixed(1)}m | avg finish->resolution ${log.stats.avgResolutionLagMinutes.toFixed(1)}m | last run ${log.lastRun || "never"}`);
  const active = log.opportunities
    .filter((opportunity) => opportunity.status === "detected")
    .sort((a, b) => b.theoreticalNetReturn - a.theoreticalNetReturn)
    .slice(0, 8);
  for (const opportunity of active) {
    const observedMinutes = (new Date(opportunity.lastSeenAt).getTime() - new Date(opportunity.detectedAt).getTime()) / 60_000;
    console.log(`${opportunity.confidence.toUpperCase().padEnd(6)} ${opportunity.marketSlug.slice(0, 48).padEnd(48)} | net ${(opportunity.theoreticalNetReturn * 100).toFixed(2)}% | seen ${observedMinutes.toFixed(0)}m | buyers ${opportunity.uniqueWalletBuyersAfterFinish}`);
  }
}

function actions(wallets: WalletIntelReport | null, replay: CapitalReplayResult | null, consensus: ConsensusResult | null, laneB: ShadowLog): void {
  console.log("\nACTIONABLE VERDICT");
  line();
  const recommendations: string[] = [];

  if (replay) {
    if (replay.acceptedResolvedTrades < PILOT_RESOLVED_TARGET) {
      recommendations.push(`Keep paper validation running: ${PILOT_RESOLVED_TARGET - replay.acceptedResolvedTrades} more resolved accepted trades needed before the $300 pilot.`);
    } else if (replay.netPnl > 0 && replay.maxDrawdownPct <= 20) {
      recommendations.push("The 30-trade pilot gate is met with positive constrained PnL; the $300 pilot is supportable from replay evidence.");
    } else {
      recommendations.push("Do not fund yet: the resolved-trade gate is met, but constrained PnL/drawdown does not support deployment.");
    }
  }

  if (wallets) {
    const tierA = wallets.wallets.filter((wallet) => wallet.tier === "A");
    const drops = wallets.wallets.filter((wallet) => wallet.tier === "DROP");
    if (tierA.length) recommendations.push(`Prioritize Tier A signals: ${tierA.map((wallet) => wallet.label ?? wallet.address.slice(0, 10)).join(", ")}.`);
    if (drops.length) recommendations.push(`Stop allocating research capital to DROP wallets: ${drops.map((wallet) => wallet.label ?? wallet.address.slice(0, 10)).join(", ")}.`);
  }

  if (consensus) {
    const enoughComparison = consensus.consensusResolvedCopies >= 3 && consensus.soloResolvedCopies >= 3;
    if (enoughComparison && consensus.consensusResolvedWinRate > consensus.soloResolvedWinRate && consensus.consensusResolvedPnl > 0) {
      recommendations.push("Consensus is outperforming solo copies; use it as a sizing multiplier, not a separate duplicate trade.");
    } else if (consensus.consensusMissed > 0) {
      recommendations.push("Log missed consensus outcomes before changing admission rules; current missed count alone does not prove incremental edge.");
    }
  }

  if (laneB.stats.totalResolved >= 10) {
    if (laneB.stats.totalShadowPnl > 0 && laneB.stats.avgRealizedReturn > 0) recommendations.push("Lane B has enough positive resolved shadow evidence for a tightly sized execution pilot.");
    else recommendations.push("Lane B has enough observations but no positive net shadow edge; keep it out of execution.");
  } else {
    recommendations.push(`Lane B remains research-only until at least ${10 - laneB.stats.totalResolved} more opportunities resolve.`);
  }

  for (let index = 0; index < recommendations.length; index++) console.log(`${index + 1}. ${recommendations[index]}`);
}

async function main(): Promise<void> {
  console.log(`=== POLYMARKET RESEARCH SUMMARY — ${new Date().toISOString()} ===`);
  const laneB = loadLaneBLog();
  const [walletResult, replayResult, consensusResult] = await Promise.allSettled([
    analyzeWalletIntel(),
    runCapitalReplay(),
    analyzeConsensus(),
  ]);

  const wallets = walletResult.status === "fulfilled" ? walletResult.value : null;
  const replay = replayResult.status === "fulfilled" ? replayResult.value : null;
  const consensus = consensusResult.status === "fulfilled" ? consensusResult.value : null;

  if (wallets) walletSection(wallets);
  else console.log(`\nWALLET TIERS FAILED: ${walletResult.status === "rejected" ? String(walletResult.reason) : "unknown"}`);
  if (replay) replaySection(replay);
  else console.log(`\nCAPITAL REPLAY FAILED: ${replayResult.status === "rejected" ? String(replayResult.reason) : "unknown"}`);
  if (consensus) consensusSection(consensus);
  else console.log(`\nCONSENSUS FAILED: ${consensusResult.status === "rejected" ? String(consensusResult.reason) : "unknown"}`);
  laneBSection(laneB);
  actions(wallets, replay, consensus, laneB);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
