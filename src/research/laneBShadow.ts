/**
 * LANE B — Post-Final Resolution-Lag Shadow Logger
 * 
 * SEPARATE from the main wallet-copy pipeline. Does NOT modify any existing
 * file or table. Stores data in data/laneb_shadow.json (isolated).
 * 
 * Monitors sports markets that have FINISHED (game over) but NOT YET RESOLVED
 * (oracle hasn't settled). Logs the opportunity window: price, time, wallet
 * activity. This data tells us whether a "buy the winner after the game ends"
 * strategy is viable.
 * 
 * Usage: npx tsx src/research/laneBShadow.ts
 * Loop:  npx tsx src/research/laneBLoop.ts (runs every 3 min)
 */
import { fetchJson, GAMMA_API, CLOB_API, DATA_API } from "../adapters/polymarket.js";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const SHADOW_FILE = path.join(DATA_DIR, "laneb_shadow.json");
const MAX_OPPORTUNITIES = 500; // prune old resolved entries to prevent unbounded growth
const FETCH_TIMEOUT_MS = 15_000; // prevent hanging on slow API responses
const MAX_RESOLUTION_CHECKS_PER_PASS = 10; // limit API calls for resolution checks

/** fetchJson with timeout wrapper */
async function safeFetch<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchJson<T>(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Types ---
interface ShadowOpportunity {
  id: string; // slug + timestamp
  slug: string;
  question: string;
  category: string | null;
  finishedAt: string | null; // when the game ended (from market metadata)
  detectedAt: string; // when we first saw this opportunity
  resolvedAt: string | null; // when the market officially resolved
  // Price data
  winningOutcome: string | null;
  winningTokenId: string | null;
  bestAskAtDetection: number | null;
  bestBidAtDetection: number | null;
  spreadAtDetection: number | null;
  // Wallet activity after finish
  walletBuysAfterFinish: number;
  walletBuyDetails: { wallet: string; price: number; size: number; time: string }[];
  // Economics
  theoreticalReturn: number | null; // (1 - ask) / ask if bought at detection
  status: "detected" | "resolved_win" | "resolved_lose" | "expired";
}

interface ShadowLog {
  opportunities: ShadowOpportunity[];
  lastRun: string;
  stats: {
    totalDetected: number;
    totalResolved: number;
    avgReturn: number;
    winRate: number;
  };
}

// --- Sports slug detection ---
const SPORTS_PREFIXES = new Set([
  "mlb", "nba", "nfl", "nhl", "epl", "ucl", "mex", "mls", "fifa", "fifwc",
  "wnba", "ncaaf", "ncaab", "tennis", "golf", "ufc", "boxing", "f1", "nascar",
  "atp", "wta", "itf", "challenger",
]);

function isSportsSlug(slug: string | null | undefined): boolean {
  if (!slug) return false;
  return SPORTS_PREFIXES.has(slug.split("-")[0].toLowerCase());
}

// --- Storage ---
function loadLog(): ShadowLog {
  try {
    if (fs.existsSync(SHADOW_FILE)) {
      return JSON.parse(fs.readFileSync(SHADOW_FILE, "utf-8"));
    }
  } catch { /* fresh start */ }
  return { opportunities: [], lastRun: "", stats: { totalDetected: 0, totalResolved: 0, avgReturn: 0, winRate: 0 } };
}

function saveLog(log: ShadowLog): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SHADOW_FILE, JSON.stringify(log, null, 2));
}

// --- API helpers ---
async function getActiveSportsMarkets(): Promise<any[]> {
  // Get markets that are active, not closed, with sports slugs
  const qs = new URLSearchParams({
    active: "true",
    closed: "false",
    limit: "100",
    order: "volume24hr",
    ascending: "false",
  });
  const markets = await safeFetch<any[]>(`${GAMMA_API}/markets?${qs}`);
  return markets.filter((m: any) => isSportsSlug(m.slug));
}

async function getOrderBookEdges(tokenId: string): Promise<{ bestAsk: number | null; bestBid: number | null; spread: number | null }> {
  try {
    const book = await safeFetch<any>(`${CLOB_API}/book?token_id=${tokenId}`);
    const asks = (book.asks ?? []).map((x: any) => Number(x.price)).filter(Number.isFinite).sort((a: number, b: number) => a - b);
    const bids = (book.bids ?? []).map((x: any) => Number(x.price)).filter(Number.isFinite).sort((a: number, b: number) => b - a);
    const bestAsk = asks[0] ?? null;
    const bestBid = bids[0] ?? null;
    return { bestAsk, bestBid, spread: bestAsk != null && bestBid != null ? bestAsk - bestBid : null };
  } catch {
    return { bestAsk: null, bestBid: null, spread: null };
  }
}

async function getWalletTradesForMarket(conditionId: string): Promise<{ wallet: string; price: number; size: number; time: string; side: string }[]> {
  try {
    const qs = new URLSearchParams({ market: conditionId, limit: "50" });
    const trades = await safeFetch<any[]>(`${DATA_API}/trades?${qs}`);
    return trades.map((t: any) => ({
      wallet: t.proxyWallet ?? "",
      price: Number(t.price ?? 0),
      size: Number(t.size ?? 0),
      time: new Date(Number(t.timestamp) * 1000).toISOString(),
      side: t.side ?? "BUY",
    }));
  } catch {
    return [];
  }
}

// --- Main scan ---
export async function runLaneBScan(): Promise<void> {
  const log = loadLog();
  const now = new Date();
  console.log(`\n[${now.toISOString()}] Lane B scan starting...`);

  // 1. Find sports markets that are still active but might be finished
  const markets = await getActiveSportsMarkets();
  console.log(`  Active sports markets: ${markets.length}`);

  let newDetections = 0;

  for (const mkt of markets) {
    const slug = mkt.slug as string;
    const endDate = mkt.endDate ? new Date(mkt.endDate) : null;

    // Heuristic: market is "likely finished" if endDate is in the past
    // but market is still active (not resolved)
    if (!endDate || endDate > now) continue; // not finished yet
    const hoursSinceEnd = (now.getTime() - endDate.getTime()) / 3_600_000;
    if (hoursSinceEnd > 6) continue; // too old, probably resolving soon or stuck

    // Check if we already logged this
    const existingId = slug;
    if (log.opportunities.find((o) => o.id === existingId)) continue;

    // Parse outcomes and find the likely winner (price > 0.90)
    const outcomes: string[] = Array.isArray(mkt.outcomes) ? (typeof mkt.outcomes === "string" ? JSON.parse(mkt.outcomes) : mkt.outcomes) : [];
    const prices: number[] = (Array.isArray(mkt.outcomePrices) ? (typeof mkt.outcomePrices === "string" ? JSON.parse(mkt.outcomePrices) : mkt.outcomePrices) : []).map(Number);
    const tokenIds: string[] = Array.isArray(mkt.clobTokenIds) ? (typeof mkt.clobTokenIds === "string" ? JSON.parse(mkt.clobTokenIds) : mkt.clobTokenIds) : [];

    // Find the winning outcome (highest price)
    let winIdx = -1;
    let maxPrice = 0;
    for (let i = 0; i < prices.length; i++) {
      if (prices[i] > maxPrice) { maxPrice = prices[i]; winIdx = i; }
    }

    // Only interesting if the "winner" is between 0.90 and 0.995
    // (below 0.90 = uncertain, above 0.995 = no profit)
    if (maxPrice < 0.90 || maxPrice > 0.995) continue;
    if (winIdx < 0 || !tokenIds[winIdx]) continue;

    // Get CLOB book for the winning token
    const edges = await getOrderBookEdges(tokenIds[winIdx]);
    await new Promise((r) => setTimeout(r, 200));

    if (edges.bestAsk == null || edges.bestAsk > 0.995 || edges.bestAsk < 0.90) continue;

    // Check wallet activity on this market
    const conditionId = mkt.conditionId ?? "";
    const walletTrades = conditionId ? await getWalletTradesForMarket(conditionId) : [];
    await new Promise((r) => setTimeout(r, 200));

    const buysAfterFinish = walletTrades.filter((t) =>
      t.side === "BUY" && new Date(t.time) > endDate
    );

    const theoreticalReturn = edges.bestAsk > 0 ? (1 - edges.bestAsk) / edges.bestAsk : null;

    const opp: ShadowOpportunity = {
      id: existingId,
      slug,
      question: mkt.question ?? slug,
      category: mkt.category ?? null,
      finishedAt: endDate.toISOString(),
      detectedAt: now.toISOString(),
      resolvedAt: null,
      winningOutcome: outcomes[winIdx] ?? null,
      winningTokenId: tokenIds[winIdx],
      bestAskAtDetection: edges.bestAsk,
      bestBidAtDetection: edges.bestBid,
      spreadAtDetection: edges.spread,
      walletBuysAfterFinish: buysAfterFinish.length,
      walletBuyDetails: buysAfterFinish.slice(0, 10).map((t) => ({
        wallet: t.wallet.slice(0, 10),
        price: t.price,
        size: t.size,
        time: t.time,
      })),
      theoreticalReturn,
      status: "detected",
    };

    log.opportunities.push(opp);
    newDetections++;
    console.log(`  NEW: ${slug} | ask=${edges.bestAsk.toFixed(3)} | return=${((theoreticalReturn ?? 0) * 100).toFixed(1)}% | ${buysAfterFinish.length} wallet buys after finish`);
  }

  // 2. Check if any previously detected opportunities have resolved (capped per pass)
  let newResolutions = 0;
  const pendingResolution = log.opportunities.filter((o) => o.status === "detected").slice(0, MAX_RESOLUTION_CHECKS_PER_PASS);
  for (const opp of pendingResolution) {
    // Check if market is now closed
    try {
      const qs = new URLSearchParams({ slug: opp.slug, limit: "1" });
      const arr = await safeFetch<any[]>(`${GAMMA_API}/markets?${qs}`);
      await new Promise((r) => setTimeout(r, 200));
      const mkt = arr[0];
      if (!mkt) continue;

      if (mkt.closed === true) {
        const prices: number[] = (Array.isArray(mkt.outcomePrices) ? (typeof mkt.outcomePrices === "string" ? JSON.parse(mkt.outcomePrices) : mkt.outcomePrices) : []).map(Number);
        const tokenIds: string[] = Array.isArray(mkt.clobTokenIds) ? (typeof mkt.clobTokenIds === "string" ? JSON.parse(mkt.clobTokenIds) : mkt.clobTokenIds) : [];
        const winIdx = tokenIds.indexOf(opp.winningTokenId ?? "");
        if (winIdx >= 0 && prices[winIdx] != null) {
          const settled = prices[winIdx] >= 0.995;
          opp.status = settled ? "resolved_win" : "resolved_lose";
          opp.resolvedAt = now.toISOString();
          newResolutions++;
          console.log(`  RESOLVED: ${opp.slug} → ${opp.status} (settlement=${prices[winIdx].toFixed(3)})`);
        }
      }
    } catch { /* skip */ }
  }

  // 3. Prune old resolved opportunities to prevent unbounded growth
  const resolvedOpps = log.opportunities.filter((o) => o.status.startsWith("resolved"));
  if (log.opportunities.length > MAX_OPPORTUNITIES && resolvedOpps.length > 50) {
    // Keep all detected + most recent 50 resolved
    const detected = log.opportunities.filter((o) => o.status === "detected");
    const recentResolved = resolvedOpps.slice(-50);
    log.opportunities = [...detected, ...recentResolved];
    console.log(`  Pruned to ${log.opportunities.length} entries (was ${detected.length + resolvedOpps.length})`);
  }

  // 4. Update stats
  const resolved = log.opportunities.filter((o) => o.status.startsWith("resolved"));
  const wins = resolved.filter((o) => o.status === "resolved_win");
  log.stats = {
    totalDetected: log.opportunities.length,
    totalResolved: resolved.length,
    avgReturn: wins.length ? wins.reduce((s, o) => s + (o.theoreticalReturn ?? 0), 0) / wins.length : 0,
    winRate: resolved.length ? wins.length / resolved.length : 0,
  };
  log.lastRun = now.toISOString();

  saveLog(log);
  console.log(`  Done: ${newDetections} new, ${newResolutions} resolved. Total: ${log.stats.totalDetected} detected, ${log.stats.totalResolved} resolved, ${Math.round(log.stats.winRate * 100)}% win rate`);
}

// Run once if called directly (ESM-compatible)
const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("laneBShadow.ts") ?? false;
if (isMain) {
  runLaneBScan().catch(console.error);
}
