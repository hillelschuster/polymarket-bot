/**
 * RESEARCH MODULE — Consensus Analysis
 * 
 * Analyzes observed trades for multi-wallet agreement patterns.
 * When 2+ tracked wallets bet the same token within a time window,
 * does that correlate with better outcomes? READ-ONLY.
 * 
 * Usage: npx tsx src/research/consensusAnalysis.ts
 */
import { prisma } from "../lib/db.js";

const CONSENSUS_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

interface SignalGroup {
  tokenId: string;
  slug: string;
  wallets: string[];
  timestamps: Date[];
  prices: number[];
  sizes: number[];
  windowMs: number; // time between first and last signal
  walletCount: number;
  // Outcome (if we have a paper trade for this)
  hasCopy: boolean;
  copyPnl: number | null;
  copyStatus: string | null;
}

async function main() {
  console.log("=== CONSENSUS ANALYSIS ===\n");
  console.log(`Window: ${CONSENSUS_WINDOW_MS / 60000} minutes\n`);

  // Get all observed BUY trades with token info
  const trades = await prisma.observedTrade.findMany({
    where: {
      side: "BUY",
      tokenId: { not: null },
      slug: { not: null },
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
  });

  console.log(`Total BUY signals with tokenId: ${trades.length}\n`);

  // Group by tokenId
  const byToken = new Map<string, typeof trades>();
  for (const t of trades) {
    if (!t.tokenId) continue;
    const arr = byToken.get(t.tokenId) ?? [];
    arr.push(t);
    byToken.set(t.tokenId, arr);
  }

  // Find consensus events: 2+ DIFFERENT wallets on same token within window
  const consensusEvents: SignalGroup[] = [];
  const soloEvents: SignalGroup[] = [];

  for (const [tokenId, tokenTrades] of byToken.entries()) {
    if (tokenTrades.length < 2) {
      if (tokenTrades.length === 1) {
        soloEvents.push({
          tokenId,
          slug: tokenTrades[0].slug ?? "",
          wallets: [tokenTrades[0].walletAddress],
          timestamps: [tokenTrades[0].timestamp!],
          prices: [tokenTrades[0].detectedPrice ?? 0],
          sizes: [tokenTrades[0].size ?? 0],
          windowMs: 0,
          walletCount: 1,
          hasCopy: false,
          copyPnl: null,
          copyStatus: null,
        });
      }
      continue;
    }

    // Sort by time
    const sorted = [...tokenTrades].sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));

    // Sliding window: find clusters of different wallets
    const uniqueWallets = new Set(sorted.map((t) => t.walletAddress));
    if (uniqueWallets.size < 2) {
      // Same wallet, multiple fills = scale-in, not consensus
      soloEvents.push({
        tokenId,
        slug: sorted[0].slug ?? "",
        wallets: [...uniqueWallets],
        timestamps: sorted.map((t) => t.timestamp!),
        prices: sorted.map((t) => t.detectedPrice ?? 0),
        sizes: sorted.map((t) => t.size ?? 0),
        windowMs: (sorted[sorted.length - 1].timestamp?.getTime() ?? 0) - (sorted[0].timestamp?.getTime() ?? 0),
        walletCount: 1,
        hasCopy: false,
        copyPnl: null,
        copyStatus: null,
      });
      continue;
    }

    // Check if different wallets are within the consensus window
    const first = sorted[0].timestamp?.getTime() ?? 0;
    const inWindow = sorted.filter((t) => (t.timestamp?.getTime() ?? 0) - first <= CONSENSUS_WINDOW_MS);
    const windowWallets = new Set(inWindow.map((t) => t.walletAddress));

    if (windowWallets.size >= 2) {
      consensusEvents.push({
        tokenId,
        slug: sorted[0].slug ?? "",
        wallets: [...windowWallets],
        timestamps: inWindow.map((t) => t.timestamp!),
        prices: inWindow.map((t) => t.detectedPrice ?? 0),
        sizes: inWindow.map((t) => t.size ?? 0),
        windowMs: (inWindow[inWindow.length - 1].timestamp?.getTime() ?? 0) - first,
        walletCount: windowWallets.size,
        hasCopy: false,
        copyPnl: null,
        copyStatus: null,
      });
    }
  }

  // Match consensus events with our paper trades (did we copy them?)
  const paperTrades = await prisma.paperTrade.findMany({
    where: { tokenId: { not: null } },
    select: { tokenId: true, unrealizedPnl: true, realizedPnl: true, status: true },
  });
  const paperByToken = new Map<string, typeof paperTrades[0]>();
  for (const pt of paperTrades) {
    if (pt.tokenId) paperByToken.set(pt.tokenId, pt);
  }

  for (const ev of [...consensusEvents, ...soloEvents]) {
    const pt = paperByToken.get(ev.tokenId);
    if (pt) {
      ev.hasCopy = true;
      ev.copyPnl = pt.status !== "open" ? (pt.realizedPnl ?? 0) : (pt.unrealizedPnl ?? 0);
      ev.copyStatus = pt.status;
    }
  }

  // Report
  console.log(`=== CONSENSUS EVENTS (2+ wallets, ${CONSENSUS_WINDOW_MS / 60000}min window) ===`);
  console.log(`Total consensus events: ${consensusEvents.length}`);
  console.log(`Total solo events: ${soloEvents.length}\n`);

  // Consensus with copies
  const consensusCopied = consensusEvents.filter((e) => e.hasCopy);
  const consensusNotCopied = consensusEvents.filter((e) => !e.hasCopy);
  const soloCopied = soloEvents.filter((e) => e.hasCopy);

  console.log(`Consensus events we copied: ${consensusCopied.length}`);
  console.log(`Consensus events we MISSED: ${consensusNotCopied.length}`);
  console.log(`Solo events we copied: ${soloCopied.length}\n`);

  // PnL comparison
  const consensusPnl = consensusCopied.reduce((s, e) => s + (e.copyPnl ?? 0), 0);
  const soloPnl = soloCopied.reduce((s, e) => s + (e.copyPnl ?? 0), 0);
  const consensusWins = consensusCopied.filter((e) => (e.copyPnl ?? 0) > 0).length;
  const soloWins = soloCopied.filter((e) => (e.copyPnl ?? 0) > 0).length;

  console.log("=== PnL BY SIGNAL TYPE ===");
  console.log(`Consensus copies: ${consensusCopied.length} trades, PnL $${consensusPnl.toFixed(2)}, win ${consensusCopied.length ? Math.round(consensusWins / consensusCopied.length * 100) : 0}%`);
  console.log(`Solo copies:      ${soloCopied.length} trades, PnL $${soloPnl.toFixed(2)}, win ${soloCopied.length ? Math.round(soloWins / soloCopied.length * 100) : 0}%`);

  // Missed consensus (what we left on the table)
  if (consensusNotCopied.length) {
    console.log(`\n=== MISSED CONSENSUS (not copied) ===`);
    for (const ev of consensusNotCopied.slice(0, 20)) {
      const time = ev.timestamps[0]?.toISOString().slice(5, 16).replace("T", " ") ?? "?";
      console.log(`  ${time} | ${ev.slug.slice(0, 35).padEnd(35)} | ${ev.walletCount} wallets | prices: ${ev.prices.map((p) => p.toFixed(2)).join(", ")}`);
    }
  }

  // Wallet agreement matrix
  console.log("\n=== WALLET AGREEMENT MATRIX (top pairs) ===");
  const pairCount = new Map<string, number>();
  for (const ev of consensusEvents) {
    const wallets = ev.wallets.sort();
    for (let i = 0; i < wallets.length; i++) {
      for (let j = i + 1; j < wallets.length; j++) {
        const key = `${wallets[i].slice(0, 10)}|${wallets[j].slice(0, 10)}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }
  const topPairs = [...pairCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [pair, count] of topPairs) {
    const [a, b] = pair.split("|");
    console.log(`  ${a}... ↔ ${b}... : ${count} shared bets`);
  }

  // Scale-in detection (same wallet, same token, multiple fills)
  console.log("\n=== SCALE-IN DETECTION (same wallet, same token, 2+ fills) ===");
  const scaleIns = soloEvents.filter((e) => e.timestamps.length >= 2 && e.walletCount === 1);
  console.log(`Scale-in events: ${scaleIns.length}`);
  const scaleInCopied = scaleIns.filter((e) => e.hasCopy);
  const scaleInPnl = scaleInCopied.reduce((s, e) => s + (e.copyPnl ?? 0), 0);
  console.log(`Scale-ins we copied: ${scaleInCopied.length}, PnL: $${scaleInPnl.toFixed(2)}`);
  if (scaleIns.length) {
    console.log("\nTop scale-ins by total size:");
    const topScaleIns = scaleIns
      .map((e) => ({ ...e, totalSize: e.sizes.reduce((s, x) => s + x, 0) }))
      .sort((a, b) => b.totalSize - a.totalSize)
      .slice(0, 10);
    for (const ev of topScaleIns) {
      console.log(`  ${ev.slug.slice(0, 30).padEnd(30)} | ${ev.timestamps.length} fills | total ${ev.totalSize.toFixed(0)} shares | ${ev.hasCopy ? `copied, PnL $${(ev.copyPnl ?? 0).toFixed(2)}` : "NOT copied"}`);
    }
  }
}

main().catch(console.error);
