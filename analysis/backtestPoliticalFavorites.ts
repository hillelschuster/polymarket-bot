// Historical backtest of the political_favorites strategy.
// Universe: 36 known strategy markets (direct-fetched from Gamma) +
//          closed markets paginated as far as Gamma allows +
//          tag-based discovery.
// Reuses sportsBacktest.ts functions for fill simulation.
// Non-replayable gates flagged explicitly — NOT silently dropped.
// Run: npx tsx analysis/backtestPoliticalFavorites.ts 2>&1
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { DATA_API, GAMMA_API, fetchJson } from "../src/adapters/polymarket.js";
import {
  parseStringList,
  simulateTakerBuy,
  takerFeePerShare,
  summarizeBacktest,
  type BacktestRow,
  type HistoricalTrade,
} from "./sportsBacktest.js";

interface GMarket {
  id: string; slug: string; question: string; conditionId?: string;
  outcomes?: unknown; outcomePrices?: unknown; clobTokenIds?: unknown;
  endDate?: string | null; category?: string | null;
  liquidityNum?: number | string; volume24hr?: number | string;
  active?: boolean; closed?: boolean;
}

interface Config {
  maxPages: number; concurrency: number; startDate: string;
  entryMinutesBeforeResolution: number;
  priceLookbackHours: number; fillWindowSeconds: number;
  budget: number; minFillRatio: number; tickSize: number;
}

function numberEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]); return Number.isFinite(v) ? v : fallback;
}

function configFromEnv(): Config {
  return {
    maxPages: Math.max(1, Math.floor(numberEnv("POLITICAL_MAX_PAGES", 5000))),
    concurrency: Math.max(1, Math.min(8, numberEnv("POLITICAL_CONCURRENCY", 3))),
    startDate: process.env.POLITICAL_START_DATE ?? "2024-01-01",
    entryMinutesBeforeResolution: Math.max(1, numberEnv("POLITICAL_ENTRY_MINUTES", 1440)),
    priceLookbackHours: Math.max(1, numberEnv("POLITICAL_LOOKBACK_HOURS", 168)),
    fillWindowSeconds: Math.max(1, numberEnv("POLITICAL_FILL_WINDOW_SECONDS", 300)),
    budget: Math.max(1, numberEnv("POLITICAL_BUDGET", 10)),
    minFillRatio: Math.min(1, Math.max(0.5, numberEnv("POLITICAL_MIN_FILL_RATIO", 0.95))),
    tickSize: 0.01,
  };
}

// --- Scanner filters (verbatim from scanPoliticalFavorites.ts) ---
const POLITICAL_PREFIXES = new Set([
  "politics","political","election","president","presidential",
  "senate","congress","governor","mayor","referendum","ballot",
  "trump","biden","democrat","republican","gop","dnc","rnc",
  "supreme-court","scotus","impeach","cabinet","nominee",
  "primary","caucus","incumbent","challenger","poll","polls",
]);
const EXCLUSION_KEYWORDS = new Set([
  "fed","federal-reserve","interest-rate","rates","fomc","powell",
  "inflation","gdp","unemployment","treasury","bond","monetary",
]);
function isPolitical(slug: string, question: string, category?: string | null): boolean {
  if (category?.toLowerCase().includes("politic") || category?.toLowerCase().includes("election")) return true;
  for (const kw of EXCLUSION_KEYWORDS) {
    if (slug.includes(kw) || question.includes(kw)) return false;
  }
  return slug.split("-").some((t) => POLITICAL_PREFIXES.has(t)) ||
    ["president","election","congress","senate","governor","political","primary","nominee"]
      .some((kw) => question.includes(kw));
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") try { return JSON.parse(raw).map(String); } catch { return []; }
  return [];
}
function parseNumArray(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === "string") try { return JSON.parse(raw).map(Number); } catch { return []; }
  return [];
}

interface PricePoint { t: number; p: number; }

async function fetchPriceHistory(tokenId: string): Promise<PricePoint[]> {
  try {
    const d = await fetchJson<{ history: { t: number; p: number }[] }>(
      `https://clob.polymarket.com/prices-history?interval=max&market=${tokenId}&fidelity=3600`
    );
    return (d.history ?? []).filter((h) => h.t > 0 && h.p > 0 && h.p < 1);
  } catch { return []; }
}

async function fetchTakerTrades(conditionId: string, start: number, end: number): Promise<HistoricalTrade[]> {
  const qs = new URLSearchParams({ market: conditionId, limit: "10000", takerOnly: "true" });
  const raw = await fetchJson<any[]>(DATA_API + "/trades?" + qs);
  if (!Array.isArray(raw)) return [];
  const trades: HistoricalTrade[] = [];
  for (const t of raw) {
    const asset = String(t.asset ?? ""); const side = String(t.side ?? "");
    const size = Number(t.size); const price = Number(t.price); const ts = Number(t.timestamp);
    if (!asset || !side || !(size > 0) || !(price > 0 && price < 1) || !Number.isFinite(ts)) continue;
    if (ts < start || ts > end) continue;
    trades.push({ asset, side, size, price, timestamp: ts });
  }
  return trades.sort((a, b) => a.timestamp - b.timestamp);
}

async function getFinalOutcome(marketId: string, tokenId: string): Promise<{ won: boolean | null }> {
  try {
    const m = await fetchJson<any>(GAMMA_API + "/markets/" + marketId);
    if (!m || !m.id) return { won: null };
    const prices = parseNumArray(m.outcomePrices);
    const tokens = parseJsonArray(m.clobTokenIds);
    if (prices.length !== 2 || tokens.length !== 2) return { won: null };
    if (!prices.every((p) => Number.isFinite(p) && (p <= 0.005 || p >= 0.995))) return { won: null };
    const winners = prices.map((p, i) => ({ p, i })).filter((x) => x.p >= 0.995);
    if (winners.length !== 1) return { won: null };
    return { won: tokens[winners[0].i] === tokenId };
  } catch { return { won: null }; }
}

function csvCell(v: unknown): string { const t = String(v ?? ""); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }
function formatPct(v: number): string { return (v * 100).toFixed(2) + "%"; }
function printSummary(label: string, rows: BacktestRow[]): void {
  if (!rows.length) { console.log(label.padEnd(18) + " n=  0"); return; }
  const s = summarizeBacktest(rows);
  console.log(label.padEnd(18) + " n=" + String(s.n).padStart(3) + " days=" + String(s.independentDays).padStart(3) +
    " win=" + formatPct(s.winRate).padStart(7) + " ROI=" + formatPct(s.roi).padStart(8) +
    " PnL=$" + s.pnl.toFixed(2).padStart(8) + " CI=[" + formatPct(s.ci95Low) + ", " + formatPct(s.ci95High) + "]");
}

function findEntryPoint(prices: PricePoint[], endDate: string, minDaysBefore: number, maxDaysBefore: number, minPrice: number, maxPrice: number): { ts: number; price: number } | null {
  if (prices.length < 2) return null;
  const endTs = new Date(endDate).getTime() / 1000;
  if (!Number.isFinite(endTs)) return null;
  const minTs = endTs - maxDaysBefore * 86400;
  const maxTs = endTs - minDaysBefore * 86400;
  for (const pt of prices) {
    if (pt.t < minTs || pt.t > maxTs) continue;
    if (pt.p >= minPrice && pt.p <= maxPrice) return { ts: pt.t, price: pt.p };
  }
  return null;
}

interface BacktestRowWithMeta extends BacktestRow { fillSource: "taker_print" | "synthetic"; }

async function fetchMarketById(id: string): Promise<GMarket | null> {
  try {
    const m = await fetchJson<any>(GAMMA_API + "/markets/" + id);
    if (m && m.id) return m as GMarket;
    return null;
  } catch { return null; }
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const MIN_FAV_PRICE = 0.65;
  const MAX_FAV_PRICE = 0.82;
  const MIN_DTR = 1;
  const MAX_DTR = 90;
  const FEE_RATE = 0.10;

  console.log("=== Political Favorites Historical Backtest ===\n");
  console.log(JSON.stringify(config, null, 2));
  console.log("\nGates applied:   political_keywords, binary, price_in_band [0.65-0.82], dtr [1-90d]");
  console.log("NOT replayable:  liquidity_10K_500K, spread_<2%, calibrated_edge>1%, toxic_ratio, depth, ask_range\n");

  // Phase 0: fetch the 36 resolved strategy marketIds from DB (sanity check reference)
  const DB = "/var/lib/trading-bots/polymarket-bot/polymarket-bot.sqlite";
  const dbOut = execSync("sqlite3 " + DB + " \"SELECT DISTINCT marketId FROM PaperTrade WHERE status='resolved' AND source='strategy' ORDER BY marketId;\"", { encoding: "utf8", timeout: 15000 });
  const knownStrategyIds = dbOut.trim().split("\n").filter(Boolean);
  console.log("36 resolved strategy marketIds from DB: " + knownStrategyIds.length);

  // Phase 1: discover universe
  // Strategy A: fetch each of 36 known strategy markets directly
  // Strategy B: paginate closed markets as far as Gamma allows
  // Strategy C: try tag-based discovery
  const universe = new Map<string, GMarket>();

  console.log("\n[Strategy A] Fetching 36 known strategy markets directly...");
  for (let i = 0; i < knownStrategyIds.length; i++) {
    const mid = knownStrategyIds[i];
    const m = await fetchMarketById(mid);
    if (m && isPolitical((m.slug ?? "").toLowerCase(), (m.question ?? "").toLowerCase(), m.category)) {
      universe.set(mid, m);
    } else if (m) {
      // These exist but fail political filter — that's fine, report them
      const reason = !m ? "not_found" : "filtered";
      // just skip silently for now
    }
    if ((i + 1) % 12 === 0) console.log("  fetched " + (i + 1) + "/36");
  }
  console.log("  Found " + universe.size + " political markets from direct fetch");

  // Strategy B: paginate closed markets (default sort)
  console.log("\n[Strategy B] Paginating closed markets (default sort)...");
  let paginated = 0;
  for (let offset = 0; offset < config.maxPages; offset += 100) {
    let page: GMarket[];
    try {
      page = await fetchJson<GMarket[]>(GAMMA_API + "/markets?closed=true&limit=100&offset=" + offset);
    } catch { break; }
    if (!Array.isArray(page) || page.length === 0) break;
    paginated += page.length;
    for (const m of page) {
      const mid = String(m.id ?? "");
      if (universe.has(mid)) continue;
      const slug = (m.slug ?? "").toLowerCase();
      const q = (m.question ?? "").toLowerCase();
      if (!isPolitical(slug, q, m.category)) continue;
      const tokens = parseJsonArray(m.clobTokenIds);
      if (tokens.length !== 2) continue;
      const end = m.endDate;
      if (!end || end < config.startDate) continue;
      universe.set(mid, m);
    }
    if (page.length < 100) break;
  }
  console.log("  Paginated " + paginated + " markets, found " + universe.size + " total political candidates");

  // Strategy C: try relevant tag IDs (House Races, federal government)
  console.log("\n[Strategy C] Checking tag IDs...");
  for (const tagId of ["100344", "933", "240379"]) {
    try {
      const page = await fetchJson<GMarket[]>(GAMMA_API + "/markets?closed=true&limit=100&tag_id=" + tagId);
      if (Array.isArray(page)) {
        for (const m of page) {
          const mid = String(m.id ?? "");
          if (universe.has(mid)) continue;
          if (!isPolitical((m.slug ?? "").toLowerCase(), (m.question ?? "").toLowerCase(), m.category)) continue;
          const tokens = parseJsonArray(m.clobTokenIds);
          if (tokens.length !== 2) continue;
          const end = m.endDate;
          if (!end || end < config.startDate) continue;
          universe.set(mid, m);
        }
        console.log("  tag_id=" + tagId + ": found " + page.length + " markets, " + universe.size + " total candidates");
      }
    } catch { console.log("  tag_id=" + tagId + ": error"); }
  }

  // Sanity check
  const recovered = knownStrategyIds.filter((id) => universe.has(id));
  console.log("\n=== SANITY CHECK ===");
  console.log("Recovered from universe: " + recovered.length + "/" + knownStrategyIds.length);
  const missing = knownStrategyIds.filter((id) => !universe.has(id));
  if (missing.length > 0) {
    console.log("Missing strategy markets: " + missing.join(", "));
    // Check if they were excluded by the political filter
    for (const mid of missing) {
      const m = await fetchMarketById(mid);
      if (m) {
        console.log("  " + mid + " (" + (m.slug ?? "") + "): excluded by political filter");
      } else {
        console.log("  " + mid + ": not found in Gamma");
      }
    }
  }

  const candidates = [...universe.values()];
  console.log("Universe size: " + candidates.length + " political candidates");
  if (candidates.length > 0) {
    const endDates = candidates.map((m) => m.endDate ?? "").filter(Boolean).sort();
    console.log("Date range: " + endDates[0]?.slice(0, 10) + " to " + endDates[endDates.length - 1]?.slice(0, 10));
  }

  // Phase 2: entry simulation
  console.log("\n=== Entry Simulation ===\n");
  const results: BacktestRowWithMeta[] = [];
  const skipCounts = new Map<string, number>();
  const skip = (reason: string): void => { skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1); };

  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const id = String(m.id ?? "?");
    const slug = String(m.slug ?? "?");
    const endDate = m.endDate!;
    const tokens = parseJsonArray(m.clobTokenIds);
    const outcomes = parseStringList(m.outcomes);

    if (candidates.length > 5 || i % 10 === 0) {
      console.log("[" + (i + 1) + "/" + candidates.length + "] " + id + " " + slug.slice(0, 40));
    }

    try {
      const ph0 = await fetchPriceHistory(tokens[0]);
      const ph1 = await fetchPriceHistory(tokens[1]);

      if (ph0.length < 2 && ph1.length < 2) { skip("no_price_history"); continue; }

      let best: { ts: number; price: number; tokenIdx: number } | null = null;
      for (let t = 0; t < 2; t++) {
        const ep = findEntryPoint(t === 0 ? ph0 : ph1, endDate, MIN_DTR, MAX_DTR, MIN_FAV_PRICE, MAX_FAV_PRICE);
        if (ep && (!best || ep.ts < best.ts)) best = { ts: ep.ts, price: ep.price, tokenIdx: t };
      }
      if (!best) { skip("no_in_band"); continue; }

      const favTokenId = tokens[best.tokenIdx];
      const entryTs = best.ts;
      const refPrice = best.price;

      const outcome = await getFinalOutcome(id, favTokenId);
      if (outcome.won == null) { skip("no_outcome"); continue; }

      const dtr = (new Date(endDate).getTime() / 1000 - entryTs) / 86400;
      if (dtr < MIN_DTR || dtr > MAX_DTR) { skip("bad_dtr"); continue; }

      const lookStart = entryTs - config.priceLookbackHours * 3600;
      const fillEndTs = entryTs + config.fillWindowSeconds;
      let trades: HistoricalTrade[] = [];
      try { trades = await fetchTakerTrades(m.conditionId ?? id, lookStart, fillEndTs); } catch { trades = []; }

      const fill = simulateTakerBuy(trades, favTokenId, entryTs, config.fillWindowSeconds, config.budget, FEE_RATE, config.tickSize);

      let fillSource: "taker_print" | "synthetic";
      let avgPrice: number, aip: number, feePaid: number, shares: number, cashSpent: number, fillRatio: number, fillSecs: number;

      if (fill && fill.fillRatio >= config.minFillRatio) {
        fillSource = "taker_print";
        ({ averagePrice: avgPrice, allInPrice: aip, feePaid, shares, cashSpent, fillRatio, fillSeconds: fillSecs } = fill);
      } else {
        const sp = Math.min(0.9999, refPrice + config.tickSize);
        const fps = takerFeePerShare(sp, FEE_RATE);
        aip = sp + fps;
        if (aip < MIN_FAV_PRICE || aip > MAX_FAV_PRICE) { skip("synth_out_of_band"); continue; }
        shares = config.budget / aip;
        cashSpent = shares * aip;
        feePaid = shares * fps;
        avgPrice = sp;
        fillRatio = 1;
        fillSecs = 0;
        fillSource = "synthetic";
      }

      const won = outcome.won;
      const pnl = (won ? shares : 0) - cashSpent;
      results.push({
        sport: "political", marketId: id, conditionId: m.conditionId ?? "", slug,
        gameId: null, eventStartTime: endDate,
        favoriteOutcome: outcomes[best.tokenIdx] ?? "?",
        favoriteTokenId: favTokenId, referencePrice: refPrice,
        averageFillPrice: avgPrice, allInPrice: aip, feePaid, shares, cashSpent,
        fillRatio, fillSeconds: fillSecs, won, pnl, roi: cashSpent > 0 ? pnl / cashSpent : 0,
        fillSource,
      });
      if (candidates.length > 5) console.log("  → " + (won ? "WON" : "LOST") + " pnl=" + pnl.toFixed(2));
    } catch (e) {
      skip("api_error");
    }
  }

  // Phase 3: report
  const rows = results.sort((a, b) => Date.parse(a.eventStartTime) - Date.parse(b.eventStartTime));
  const devN = Math.floor(rows.length * 0.7);
  const dev = rows.slice(0, devN);
  const hold = rows.slice(devN);
  const takerRows = rows.filter(r => r.fillSource === "taker_print");
  const synthRows = rows.filter(r => r.fillSource === "synthetic");

  console.log("\n\n=== RESULTS ===");
  printSummary("ALL", rows);
  printSummary("DEVELOPMENT", dev);
  printSummary("HOLDOUT", hold);
  if (takerRows.length) printSummary("TAKER_PRINT", takerRows);
  if (synthRows.length) printSummary("SYNTHETIC", synthRows);

  console.log("\n--- BREAKDOWN ---");
  console.log("Universe candidates: " + candidates.length);
  console.log("Recovered strategy: " + recovered.length + "/" + knownStrategyIds.length);
  console.log("Trades executed: " + rows.length);
  console.log("  taker_print: " + takerRows.length + ", PnL=$" + takerRows.reduce((s, r) => s + r.pnl, 0).toFixed(2));
  console.log("  synthetic:   " + synthRows.length + ", PnL=$" + synthRows.reduce((s, r) => s + r.pnl, 0).toFixed(2));
  console.log("Skips: " + JSON.stringify(Object.fromEntries([...skipCounts].sort((a, b) => b[1] - a[1]))));

  console.log("\nNon-replayable gates NOT enforced:");
  console.log("  liquidity 10K-500K (Gamma returns 0 for many closed markets)");
  console.log("  spread < 2% (requires live order book)");
  console.log("  calibrated edge > 1% (requires live order book mid)");
  console.log("  volume24hr/liquidity < 15 (Gamma volume=0 for closed)");
  console.log("  depth/ask check (requires live order book)");

  const holdSummary = summarizeBacktest(hold);
  let verdict: string;
  if (rows.length < 30 || hold.length < 9) verdict = "INCONCLUSIVE_SAMPLE";
  else if (holdSummary.ci95Low > 0) verdict = "PASS_POSITIVE_HOLDOUT";
  else if (holdSummary.ci95High < 0) verdict = "FAIL_NEGATIVE_HOLDOUT";
  else verdict = "INCONCLUSIVE_EDGE_NOT_SEPARATED_FROM_ZERO";
  console.log("\nVERDICT: " + verdict);

  const report = { generatedAt: new Date().toISOString(), config,
    sanityCheck: { recovered: recovered.length, total: knownStrategyIds.length,
      missing: missing.map((id) => ({ marketId: id })) },
    counts: { candidates: candidates.length, executed: rows.length,
      takerPrint: takerRows.length, synthetic: synthRows.length,
      skips: Object.fromEntries(skipCounts) },
    nonReplayableGates: ["liquidity_10K_500K", "spread_<2%", "calibrated_edge_>1%", "volume24hr/liquidity_<15", "depth/ask_check"],
    summaries: { all: summarizeBacktest(rows), development: summarizeBacktest(dev), holdout: holdSummary,
      takerPrint: summarizeBacktest(takerRows), synthetic: summarizeBacktest(synthRows) },
    verdict, rows };
  const dir = path.join(process.cwd(), "data", "backtests");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(dir, "political-favorites-" + stamp);
  const csv = [Object.keys(rows[0] ?? {}).join(","), ...rows.map((r) => Object.values(r).map(csvCell).join(","))].join("\n");
  await Promise.all([writeFile(base + ".json", JSON.stringify(report, null, 2), "utf8"), writeFile(base + ".csv", csv, "utf8")]);
  console.log("\nSaved " + base + ".json and .csv");
}

main().catch((e) => { console.error(e); process.exit(1); });