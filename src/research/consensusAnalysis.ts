/**
 * RESEARCH MODULE — Consensus Analysis
 * READ-ONLY: analyzes observed wallet BUY campaigns and paper-copy outcomes.
 * Usage: npx tsx src/research/consensusAnalysis.ts
 */
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { prisma } from "../lib/db.js";

const PRIMARY_WINDOW_MINUTES = 20;
const PRIMARY_WINDOW_MS = PRIMARY_WINDOW_MINUTES * 60 * 1000;
const CAMPAIGN_GAP_MS = PRIMARY_WINDOW_MS;
const COPY_MATCH_BEFORE_MS = 5 * 60 * 1000;
const COPY_MATCH_AFTER_MS = 30 * 60 * 1000;
const SENSITIVITY_WINDOWS_MINUTES = [5, 10, 20, 30];
const EPSILON = 0.005;

interface ObservedBuy {
  id: string;
  walletAddress: string;
  tokenId: string | null;
  slug: string | null;
  detectedPrice: number | null;
  size: number | null;
  timestamp: Date | null;
  marketId: string;
}

interface PaperCopy {
  id: string;
  tokenId: string | null;
  openedAt: Date;
  status: string;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
}

interface WalletSignal {
  walletAddress: string;
  firstAt: Date;
  lastAt: Date;
  fillCount: number;
  totalShares: number;
  weightedAveragePrice: number | null;
}

export interface ConsensusCampaign {
  id: string;
  tokenId: string;
  slug: string;
  startAt: string;
  endAt: string;
  walletSignals: WalletSignal[];
  walletCount: number;
  fillCount: number;
  confirmationDelayMinutes: number | null;
  isConsensus: boolean;
  isLateAgreement: boolean;
  scaleInWallets: number;
  hasCopy: boolean;
  copyCount: number;
  copyStatus: "resolved" | "open" | "mixed" | null;
  copyPnl: number | null;
}

export interface ConsensusResult {
  generatedAt: string;
  primaryWindowMinutes: number;
  campaigns: ConsensusCampaign[];
  consensusEvents: number;
  lateAgreementEvents: number;
  soloEvents: number;
  consensusCopied: number;
  consensusMissed: number;
  consensusResolvedCopies: number;
  consensusResolvedPnl: number;
  consensusResolvedWinRate: number;
  soloResolvedCopies: number;
  soloResolvedPnl: number;
  soloResolvedWinRate: number;
  scaleInCampaigns: number;
  sensitivity: { windowMinutes: number; consensusEvents: number }[];
  topPairs: { walletA: string; walletB: string; sharedCampaigns: number }[];
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function tradeFingerprint(trade: ObservedBuy): string {
  return [
    trade.walletAddress.toLowerCase(),
    trade.tokenId,
    trade.timestamp?.getTime() ?? 0,
    Number(trade.size ?? 0).toFixed(8),
    Number(trade.detectedPrice ?? 0).toFixed(8),
  ].join("|");
}

function splitCampaigns(trades: ObservedBuy[], gapMs = CAMPAIGN_GAP_MS): ObservedBuy[][] {
  if (!trades.length) return [];
  const sorted = [...trades].sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));
  const campaigns: ObservedBuy[][] = [];
  let current: ObservedBuy[] = [];
  for (const trade of sorted) {
    if (!trade.timestamp) continue;
    const previous = current[current.length - 1];
    if (previous?.timestamp && trade.timestamp.getTime() - previous.timestamp.getTime() > gapMs) {
      campaigns.push(current);
      current = [];
    }
    current.push(trade);
  }
  if (current.length) campaigns.push(current);
  return campaigns;
}

function aggregateWalletSignals(trades: ObservedBuy[]): WalletSignal[] {
  const byWallet = new Map<string, ObservedBuy[]>();
  for (const trade of trades) {
    const key = trade.walletAddress.toLowerCase();
    const list = byWallet.get(key) ?? [];
    list.push(trade);
    byWallet.set(key, list);
  }

  return [...byWallet.entries()].map(([walletAddress, walletTrades]) => {
    const sorted = [...walletTrades].sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));
    const totalShares = sorted.reduce((sum, trade) => sum + Math.max(0, Number(trade.size) || 0), 0);
    const weightedPriceNumerator = sorted.reduce((sum, trade) => {
      const size = Math.max(0, Number(trade.size) || 0);
      const price = Number(trade.detectedPrice);
      return sum + (Number.isFinite(price) ? size * price : 0);
    }, 0);
    return {
      walletAddress,
      firstAt: sorted[0].timestamp!,
      lastAt: sorted[sorted.length - 1].timestamp!,
      fillCount: sorted.length,
      totalShares: round(totalShares, 4),
      weightedAveragePrice: totalShares > 0 ? round(weightedPriceNumerator / totalShares, 4) : null,
    };
  }).sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime());
}

function confirmationDelayMs(walletSignals: WalletSignal[]): number | null {
  if (walletSignals.length < 2) return null;
  return walletSignals[1].firstAt.getTime() - walletSignals[0].firstAt.getTime();
}

function classifyCopyStatus(statuses: string[]): "resolved" | "open" | "mixed" | null {
  if (!statuses.length) return null;
  if (statuses.every((status) => status === "resolved")) return "resolved";
  if (statuses.every((status) => status === "open")) return "open";
  return "mixed";
}

export async function analyzeConsensus(): Promise<ConsensusResult> {
  const [rawTradesRaw, paperTradesRaw] = await Promise.all([
    prisma.observedTrade.findMany({
      where: {
        side: "BUY",
        tokenId: { not: null },
        slug: { not: null },
        timestamp: { not: null },
      },
      orderBy: { timestamp: "asc" },
      select: {
        id: true,
        walletAddress: true,
        tokenId: true,
        slug: true,
        detectedPrice: true,
        size: true,
        timestamp: true,
        marketId: true,
      },
    }),
    prisma.paperTrade.findMany({
      where: { source: "wallet_copy", tokenId: { not: null } },
      select: {
        id: true,
        tokenId: true,
        openedAt: true,
        status: true,
        realizedPnl: true,
        unrealizedPnl: true,
      },
      orderBy: { openedAt: "asc" },
    }),
  ]);
  const rawTrades = rawTradesRaw as ObservedBuy[];
  const paperTrades = paperTradesRaw as PaperCopy[];

  const uniqueTrades: ObservedBuy[] = [];
  const fingerprints = new Set<string>();
  for (const trade of rawTrades) {
    const fingerprint = tradeFingerprint(trade);
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    uniqueTrades.push(trade);
  }

  const byToken = new Map<string, ObservedBuy[]>();
  for (const trade of uniqueTrades) {
    if (!trade.tokenId || !trade.timestamp) continue;
    const list = byToken.get(trade.tokenId) ?? [];
    list.push(trade);
    byToken.set(trade.tokenId, list);
  }

  const copiesByToken = new Map<string, PaperCopy[]>();
  for (const trade of paperTrades) {
    if (!trade.tokenId) continue;
    const list = copiesByToken.get(trade.tokenId) ?? [];
    list.push(trade);
    copiesByToken.set(trade.tokenId, list);
  }

  const campaigns: ConsensusCampaign[] = [];
  for (const [tokenId, tokenTrades] of byToken) {
    const tokenCampaigns = splitCampaigns(tokenTrades);
    for (let index = 0; index < tokenCampaigns.length; index++) {
      const trades = tokenCampaigns[index];
      if (!trades.length) continue;
      const walletSignals = aggregateWalletSignals(trades);
      const delayMs = confirmationDelayMs(walletSignals);
      const startAt = trades[0].timestamp!;
      const endAt = trades[trades.length - 1].timestamp!;
      const candidateCopies = copiesByToken.get(tokenId) ?? [];
      const matchedCopies = candidateCopies.filter((copy) => {
        const opened = copy.openedAt.getTime();
        return opened >= startAt.getTime() - COPY_MATCH_BEFORE_MS
          && opened <= endAt.getTime() + COPY_MATCH_AFTER_MS;
      });
      const copyPnls = matchedCopies.map((copy) => copy.status === "open"
        ? Number(copy.unrealizedPnl) || 0
        : Number(copy.realizedPnl) || 0);
      const copyPnl = copyPnls.length ? copyPnls.reduce((sum, pnl) => sum + pnl, 0) : null;

      campaigns.push({
        id: `${tokenId}:${startAt.toISOString()}:${index}`,
        tokenId,
        slug: trades[0].slug ?? "",
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        walletSignals,
        walletCount: walletSignals.length,
        fillCount: trades.length,
        confirmationDelayMinutes: delayMs == null ? null : round(delayMs / 60_000, 2),
        isConsensus: delayMs != null && delayMs <= PRIMARY_WINDOW_MS,
        isLateAgreement: delayMs != null && delayMs > PRIMARY_WINDOW_MS,
        scaleInWallets: walletSignals.filter((signal) => signal.fillCount >= 2).length,
        hasCopy: matchedCopies.length > 0,
        copyCount: matchedCopies.length,
        copyStatus: classifyCopyStatus(matchedCopies.map((copy) => copy.status)),
        copyPnl: copyPnl == null ? null : round(copyPnl),
      });
    }
  }

  campaigns.sort((a, b) => a.startAt.localeCompare(b.startAt));
  const consensus = campaigns.filter((campaign) => campaign.isConsensus);
  const solo = campaigns.filter((campaign) => campaign.walletCount === 1);
  const late = campaigns.filter((campaign) => campaign.isLateAgreement);
  const consensusResolved = consensus.filter((campaign) => campaign.copyStatus === "resolved");
  const soloResolved = solo.filter((campaign) => campaign.copyStatus === "resolved");

  function pnlStats(items: ConsensusCampaign[]): { pnl: number; wins: number; losses: number; winRate: number } {
    const pnls = items.map((item) => item.copyPnl ?? 0);
    const wins = pnls.filter((pnl) => pnl > EPSILON).length;
    const losses = pnls.filter((pnl) => pnl < -EPSILON).length;
    return {
      pnl: round(pnls.reduce((sum, pnl) => sum + pnl, 0)),
      wins,
      losses,
      winRate: wins + losses ? round(wins / (wins + losses), 4) : 0,
    };
  }

  const consensusStats = pnlStats(consensusResolved);
  const soloStats = pnlStats(soloResolved);
  const pairCounts = new Map<string, { walletA: string; walletB: string; count: number }>();
  for (const campaign of consensus) {
    const wallets = campaign.walletSignals.map((signal) => signal.walletAddress).sort();
    for (let i = 0; i < wallets.length; i++) {
      for (let j = i + 1; j < wallets.length; j++) {
        const key = `${wallets[i]}|${wallets[j]}`;
        const previous = pairCounts.get(key);
        pairCounts.set(key, {
          walletA: wallets[i],
          walletB: wallets[j],
          count: (previous?.count ?? 0) + 1,
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    primaryWindowMinutes: PRIMARY_WINDOW_MINUTES,
    campaigns,
    consensusEvents: consensus.length,
    lateAgreementEvents: late.length,
    soloEvents: solo.length,
    consensusCopied: consensus.filter((campaign) => campaign.hasCopy).length,
    consensusMissed: consensus.filter((campaign) => !campaign.hasCopy).length,
    consensusResolvedCopies: consensusResolved.length,
    consensusResolvedPnl: consensusStats.pnl,
    consensusResolvedWinRate: consensusStats.winRate,
    soloResolvedCopies: soloResolved.length,
    soloResolvedPnl: soloStats.pnl,
    soloResolvedWinRate: soloStats.winRate,
    scaleInCampaigns: campaigns.filter((campaign) => campaign.scaleInWallets > 0).length,
    sensitivity: SENSITIVITY_WINDOWS_MINUTES.map((windowMinutes) => {
      const windowMs = windowMinutes * 60_000;
      let consensusEvents = 0;
      for (const tokenTrades of byToken.values()) {
        for (const campaignTrades of splitCampaigns(tokenTrades, windowMs)) {
          const uniqueWallets = new Set(campaignTrades.map((trade) => trade.walletAddress.toLowerCase()));
          if (uniqueWallets.size >= 2) consensusEvents++;
        }
      }
      return { windowMinutes, consensusEvents };
    }),
    topPairs: [...pairCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((pair) => ({ walletA: pair.walletA, walletB: pair.walletB, sharedCampaigns: pair.count })),
  };
}

export function printConsensusResult(result: ConsensusResult): void {
  console.log("=== CONSENSUS ANALYSIS ===\n");
  console.log(`Primary agreement window: ${result.primaryWindowMinutes} minutes`);
  console.log(`Consensus / late / solo:  ${result.consensusEvents} / ${result.lateAgreementEvents} / ${result.soloEvents}`);
  console.log(`Copied / missed:          ${result.consensusCopied} / ${result.consensusMissed}`);
  console.log(`Scale-in campaigns:       ${result.scaleInCampaigns}`);
  console.log(`Consensus resolved:       ${result.consensusResolvedCopies}, PnL $${result.consensusResolvedPnl.toFixed(2)}, win ${(result.consensusResolvedWinRate * 100).toFixed(0)}%`);
  console.log(`Solo resolved:            ${result.soloResolvedCopies}, PnL $${result.soloResolvedPnl.toFixed(2)}, win ${(result.soloResolvedWinRate * 100).toFixed(0)}%`);
  console.log(`Window sensitivity:       ${result.sensitivity.map((item) => `${item.windowMinutes}m=${item.consensusEvents}`).join(" | ")}`);

  const missed = result.campaigns.filter((campaign) => campaign.isConsensus && !campaign.hasCopy);
  if (missed.length) {
    console.log("\n=== MISSED CONSENSUS ===");
    for (const campaign of missed.slice(0, 20)) {
      console.log(`  ${campaign.startAt.slice(5, 16).replace("T", " ")} | ${campaign.slug.slice(0, 42).padEnd(42)} | ${campaign.walletCount} wallets | confirm ${campaign.confirmationDelayMinutes?.toFixed(1)}m`);
    }
  }

  if (result.topPairs.length) {
    console.log("\n=== TOP WALLET PAIRS ===");
    for (const pair of result.topPairs) {
      console.log(`  ${pair.walletA.slice(0, 10)}... ↔ ${pair.walletB.slice(0, 10)}... : ${pair.sharedCampaigns}`);
    }
  }
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectRun()) {
  analyzeConsensus()
    .then(printConsensusResult)
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
