// Job: scan:politics. Political Favorites Scanner — independent strategy lane.
// Research basis: Le (2026) arXiv:2602.19520, 292M trades → politics markets are
// 13-18% underconfident. A 70¢ contract has ~83% true probability. Systematically
// buying political favorites in the 55-80¢ range exploits this calibration error.
//
// This scanner is MARKET-STRUCTURAL — no wallet dependency. It runs as an independent
// lane in the pipeline, creating paper trades via the existing PnL infrastructure.

import { prisma } from "../lib/db.js";
import { fetchJson, GAMMA_API, type GammaMarket } from "../adapters/polymarket.js";
import { getFavoriteGate, categoryFromSlug } from "../lib/scoring.js";

// --- Configuration (validation phase: conservative fixed sizing) ---
const STRATEGY_NAME = "political_favorites";
const POSITION_SIZE = 10; // Fixed $10 per trade during validation
const MAX_FAVORITE_PRICE = 0.85; // Don't buy extreme favorites (poor payoff/risk)
const MIN_LIQUIDITY = 5_000; // $5K minimum liquidity (lowered for faster validation)
const MAX_SPREAD = 0.08; // 8% max spread (widened for faster validation)
const MIN_DAYS_TO_RESOLUTION = 1; // Skip markets resolving too soon
const MAX_DAYS_TO_RESOLUTION = 90; // Skip markets too far out (variance, no info)
const MAX_TOXIC_RATIO = 15; // volume24hr/liquidity cap
const EDGE_MULTIPLIER = 0.15; // Conservative 15% calibration correction estimate
const PAGE_SIZE = 100; // Gamma-api max per page
const MAX_PAGES = 5; // Scan up to 500 markets per run

// Political slug prefixes (from scoring.ts CATEGORY_PREFIXES + common patterns)
const POLITICAL_PREFIXES = new Set([
  "politics", "political", "election", "president", "presidential",
  "senate", "congress", "governor", "mayor", "referendum", "ballot",
  "trump", "biden", "democrat", "republican", "gop", "dnc", "rnc",
  "fed", "federal", "government", "policy", "legislation", "bill",
  "supreme-court", "scotus", "impeach", "cabinet", "nominee",
]);

/** Check if a market is political based on slug, category, or question. */
function isPoliticalMarket(m: GammaMarket): boolean {
  // Check slug prefix
  const slugCat = categoryFromSlug(m.slug);
  if (slugCat === "politics") return true;

  // Check category field
  if (m.category?.toLowerCase().includes("politic")) return true;
  if (m.category?.toLowerCase().includes("government")) return true;
  if (m.category?.toLowerCase().includes("election")) return true;

  // Check slug keywords
  if (m.slug) {
    const tokens = m.slug.toLowerCase().split("-");
    if (tokens.some((t) => POLITICAL_PREFIXES.has(t))) return true;
  }

  // Check question keywords (last resort)
  if (m.question) {
    const q = m.question.toLowerCase();
    if (q.includes("president") || q.includes("election") || q.includes("congress") ||
        q.includes("senate") || q.includes("governor") || q.includes("political")) {
      return true;
    }
  }

  return false;
}

/** Parse gamma-api raw market into GammaMarket. */
function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return []; }
  }
  return [];
}

function parseMarket(m: any): GammaMarket {
  return {
    id: String(m.id ?? ""),
    question: m.question ?? null,
    slug: m.slug ?? null,
    category: m.category ?? null,
    outcomes: parseList(m.outcomes),
    outcomePrices: parseList(m.outcomePrices).map(Number),
    clobTokenIds: parseList(m.clobTokenIds),
    liquidity: Number(m.liquidityNum ?? 0),
    spread: Number(m.spread ?? 0),
    volume24hr: Number(m.volume24hr ?? 0),
    volume: Number(m.volumeNum ?? 0),
    endDate: m.endDate ?? null,
    active: m.active !== false,
    closed: m.closed === true,
  };
}

/** Fetch active markets from gamma-api (broad scan, filter client-side). */
async function fetchActiveMarkets(page: number): Promise<GammaMarket[]> {
  const qs = new URLSearchParams();
  qs.set("closed", "false");
  qs.set("limit", String(PAGE_SIZE));
  qs.set("offset", String(page * PAGE_SIZE));
  qs.set("order", "volume24hr");
  qs.set("ascending", "false");
  qs.set("liquidity_num_min", String(MIN_LIQUIDITY));

  const arr = await fetchJson<any[]>(`${GAMMA_API}/markets?${qs}`);
  if (!Array.isArray(arr)) return [];
  return arr.map(parseMarket);
}

/** Compute days until market resolution from endDate. */
function daysToResolution(endDate: string | null): number {
  if (!endDate) return 30; // Default assumption
  const ms = new Date(endDate).getTime() - Date.now();
  return ms / 86_400_000;
}

export interface ScanResult {
  scanned: number;
  signals: number;
  skipped: number;
  reasons: Map<string, number>;
}

/**
 * Core scanner logic. Exported for testing.
 * Scans active markets, filters for political ones, and creates paper trades for qualifying favorites.
 */
export async function runScanPoliticalFavorites(): Promise<ScanResult> {
  const result: ScanResult = { scanned: 0, signals: 0, skipped: 0, reasons: new Map() };
  const skip = (reason: string) => {
    result.skipped++;
    result.reasons.set(reason, (result.reasons.get(reason) ?? 0) + 1);
  };

  // 1. Fetch active markets (broad scan, filter client-side for political)
  const gate = getFavoriteGate("politics"); // 0.55 for politics

  let allMarkets: GammaMarket[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await fetchActiveMarkets(page);
    allMarkets = allMarkets.concat(batch);
    if (batch.length < PAGE_SIZE) break; // Last page
    await new Promise((r) => setTimeout(r, 200)); // Rate limit courtesy
  }

  // 2. Filter for political markets
  const markets = allMarkets.filter(isPoliticalMarket);
  console.log(`scanPoliticalFavorites: ${allMarkets.length} total markets, ${markets.length} political`);

  // 3. Evaluate each political market
  const processedThisRun = new Set<string>(); // In-memory dedup for this scan pass
  for (const m of markets) {
    result.scanned++;

    // 3a. Must be binary (2 outcomes)
    if (m.outcomes.length !== 2) {
      skip("non-binary");
      continue;
    }

    // 3b. Parse prices
    const yesPrice = m.outcomePrices[0] ?? 0;
    const noPrice = m.outcomePrices[1] ?? 0;

    // 3c. Determine favorite side (buy the favorite in the sweet spot)
    let outcome: string;
    let entryPrice: number;
    let favoritePrice: number;

    if (yesPrice >= gate && yesPrice <= MAX_FAVORITE_PRICE) {
      outcome = m.outcomes[0] ?? "Yes";
      entryPrice = yesPrice;
      favoritePrice = yesPrice;
    } else if (noPrice >= gate && noPrice <= MAX_FAVORITE_PRICE) {
      outcome = m.outcomes[1] ?? "No";
      entryPrice = noPrice;
      favoritePrice = noPrice;
    } else {
      skip("price-out-of-range");
      continue;
    }

    // 3c-bis. In-memory dedup: skip if already processed this market+outcome in this run
    const dedupKey = `${m.id}:${outcome}`;
    if (processedThisRun.has(dedupKey)) {
      skip("duplicate-this-run");
      continue;
    }
    processedThisRun.add(dedupKey);

    // 3d. Microstructure gates
    const dtr = daysToResolution(m.endDate);
    if (m.liquidity < MIN_LIQUIDITY) {
      skip("low-liquidity");
      continue;
    }
    if (m.spread > MAX_SPREAD) {
      skip("wide-spread");
      continue;
    }
    if (dtr < MIN_DAYS_TO_RESOLUTION || dtr > MAX_DAYS_TO_RESOLUTION) {
      skip("bad-resolution-time");
      continue;
    }
    if (m.liquidity > 0 && m.volume24hr / m.liquidity > MAX_TOXIC_RATIO) {
      skip("toxic-flow");
      continue;
    }

    // 3e. Dedup: skip if open PaperTrade already exists for this market+outcome
    const existing = await prisma.paperTrade.findFirst({
      where: {
        marketId: m.id,
        outcome,
        status: "open",
        source: "strategy",
      },
    });
    if (existing) {
      skip("duplicate");
      continue;
    }

    // 3f. Compute edge estimate (conservative calibration correction)
    // True probability ≈ favoritePrice * (1 + EDGE_MULTIPLIER)
    // Edge = trueProb - favoritePrice = favoritePrice * EDGE_MULTIPLIER
    const edgeEstimate = favoritePrice * EDGE_MULTIPLIER;

    // 3g. Create StrategySignal
    const reasons = [
      `political favorite: ${outcome} @ ${entryPrice.toFixed(2)}`,
      `gate=${gate} (politics underconfidence 13-18%)`,
      `liq=$${m.liquidity.toFixed(0)} spread=${(m.spread * 100).toFixed(1)}% dtr=${dtr.toFixed(0)}d`,
      `edge estimate: +${(edgeEstimate * 100).toFixed(1)}%`,
    ];

    const signal = await prisma.strategySignal.create({
      data: {
        strategy: STRATEGY_NAME,
        marketId: m.id,
        slug: m.slug,
        question: m.question,
        category: "politics",
        outcome,
        side: "BUY",
        entryPrice,
        favoritePrice,
        liquidity: m.liquidity,
        spread: m.spread,
        volume: m.volume24hr,
        daysToResolution: dtr,
        edgeEstimate,
        reasonsJson: JSON.stringify(reasons),
        status: "paper_copy",
      },
    });

    // 3h. Create PaperTrade (source: "strategy", fixed $10 for validation)
    const pt = await prisma.paperTrade.create({
      data: {
        walletAddress: `STRATEGY:${STRATEGY_NAME}`, // Synthetic wallet for strategy trades
        marketId: m.id,
        slug: m.slug,
        tokenId: m.clobTokenIds[m.outcomes.indexOf(outcome)] ?? null,
        outcome,
        side: "BUY",
        entryPrice,
        currentPrice: entryPrice,
        simulatedPositionSize: POSITION_SIZE,
        unrealizedPnl: 0,
        realizedPnl: null,
        status: "open",
        source: "strategy",
        strategySignalId: signal.id,
        openedAt: new Date(),
      },
    });

    // Link signal → paper trade
    await prisma.strategySignal.update({
      where: { id: signal.id },
      data: { paperTradeId: pt.id },
    });

    result.signals++;
    console.log(`  ✓ ${m.question?.slice(0, 60)} → BUY ${outcome} @ ${entryPrice.toFixed(2)} (edge +${(edgeEstimate * 100).toFixed(1)}%)`);
  }

  // 4. Summary
  console.log(`\nscanPoliticalFavorites done: ${result.scanned} scanned, ${result.signals} signals, ${result.skipped} skipped`);
  if (result.reasons.size > 0) {
    console.log("  skip reasons:", Object.fromEntries(result.reasons));
  }

  return result;
}

if (require.main === module) runScanPoliticalFavorites().catch(console.error);
