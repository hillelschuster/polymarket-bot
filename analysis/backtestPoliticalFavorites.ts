// Historical backtest of the political_favorites strategy.
// Reuses sportsBacktest.ts functions for fill simulation.
// Non-replayable gates (spread, calibrated edge, depth) flagged explicitly.
// Run: npx tsx analysis/backtestPoliticalFavorites.ts 2>&1
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_API, GAMMA_API, fetchJson } from "../src/adapters/polymarket.js";
import {
  normalizeFeeRate,
  parseStringList,
  simulateTakerBuy,
  takerFeePerShare,
  summarizeBacktest,
  bootstrapDayRoiCI,
  type BacktestRow,
  type HistoricalTrade,
} from "./sportsBacktest.js";

interface GammaMarketRaw {
  id: string | number; slug?: string; question?: string; conditionId?: string; closed?: boolean;
  outcomes?: unknown; outcomePrices?: unknown; clobTokenIds?: unknown;
  endDate?: string | null; category?: string | null;
  liquidityNum?: number | string; volume24hr?: number | string; acceptingOrders?: boolean;
  orderPriceMinTickSize?: number | string | null; feeSchedule?: { rate?: number | string | null } | null;
}

interface Config {
  maxMarkets: number; concurrency: number; startDate: string;
  entryMinutesBeforeResolution: number;
  priceLookbackHours: number; fillWindowSeconds: number;
  budget: number; minFillRatio: number; tickSize: number;
}

function numberEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]); return Number.isFinite(v) ? v : fallback;
}

function configFromEnv(): Config {
  return {
    maxMarkets: Math.max(1, Math.floor(numberEnv("POLITICAL_MAX_MARKETS", 2500))),
    concurrency: Math.max(1, Math.min(8, numberEnv("POLITICAL_CONCURRENCY", 2))),
    startDate: process.env.POLITICAL_START_DATE ?? "2024-01-01",
    entryMinutesBeforeResolution: Math.max(1, numberEnv("POLITICAL_ENTRY_MINUTES", 1440)), // 24h before end
    priceLookbackHours: Math.max(1, numberEnv("POLITICAL_LOOKBACK_HOURS", 168)), // 7 days
    fillWindowSeconds: Math.max(1, numberEnv("POLITICAL_FILL_WINDOW_SECONDS", 300)),
    budget: Math.max(1, numberEnv("POLITICAL_BUDGET", 10)),
    minFillRatio: Math.min(1, Math.max(0.5, numberEnv("POLITICAL_MIN_FILL_RATIO", 0.95))),
    tickSize: 0.01,
  };
}

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
  } catch (e) {
    console.warn("  price-history fail for token " + String(tokenId).slice(0, 20) + "...: " + (e as Error).message);
    return [];
  }
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
    const winTokenId = tokens[winners[0].i];
    return { won: winTokenId === tokenId };
  } catch (e) {
    console.warn("  outcome fail for " + marketId + ": " + (e as Error).message);
    return { won: null };
  }
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

interface BacktestRowWithMeta extends BacktestRow {
  fillSource: "taker_print" | "synthetic";
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const MIN_FAV_PRICE = 0.65;
  const MAX_FAV_PRICE = 0.82;
  const MIN_DTR = 1;
  const MAX_DTR = 90;
  const FEE_RATE = 0.10;

  console.log("=== Political Favorites Historical Backtest ===");
  console.log(JSON.stringify(config, null, 2));
  console.log("Gates applied:   political_keywords, binary, price_in_band, dtr_1_90d\n");
  console.log("Gates NOT replayable: liquidity_10K_500K, spread_<2%, calibrated_edge_>1%, toxic_ratio, depth, ask_range\n");

  // Phase 1: discover
  const PAGE_SIZE = 100;
  const candidates: GammaMarketRaw[] = [];
  console.log("Discovering closed political markets...");
  let scanned = 0;
  for (let offset = 0; offset < config.maxMarkets; offset += PAGE_SIZE) {
    let page: GammaMarketRaw[];
    try { page = await fetchJson<GammaMarketRaw[]>(GAMMA_API + "/markets?closed=true&limit=" + PAGE_SIZE + "&offset=" + offset); }
    catch { break; }
    if (!Array.isArray(page) || page.length === 0) break;
    scanned += page.length;
    for (const m of page) {
      const slug = String(m.slug ?? "").toLowerCase();
      const q = String(m.question ?? "").toLowerCase();
      if (!isPolitical(slug, q, m.category)) continue;
      const tokens = parseJsonArray(m.clobTokenIds);
      const outcomes = parseStringList(m.outcomes);
      if (tokens.length !== 2 || outcomes.length !== 2) continue;
      const end = m.endDate;
      if (!end || end < config.startDate) continue;
      candidates.push(m);
    }
    if (offset % 500 === 0) console.log("  paginated " + scanned + " total, found " + candidates.length + " candidates");
  }
  console.log("Discovered " + scanned + " closed markets, " + candidates.length + " political candidates\n");

  // Phase 2: entry simulation (serial to debug)
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

    console.log("\n[" + (i + 1) + "/" + candidates.length + "] " + id + " " + slug.slice(0, 40));

    try {
      // Fetch price history for both tokens
      const ph0 = await fetchPriceHistory(tokens[0]);
      const ph1 = await fetchPriceHistory(tokens[1]);
      const priceHistories = [ph0, ph1];

      if (ph0.length < 2 && ph1.length < 2) {
        console.log("  SKIP: no price history for either token");
        skip("no_price_history");
        continue;
      }

      // Find entry
      let best: { ts: number; price: number; tokenIdx: number } | null = null;
      for (let t = 0; t < 2; t++) {
        const ep = findEntryPoint(priceHistories[t], endDate, MIN_DTR, MAX_DTR, MIN_FAV_PRICE, MAX_FAV_PRICE);
        if (ep && (!best || ep.ts < best.ts)) best = { ts: ep.ts, price: ep.price, tokenIdx: t };
      }
      if (!best) {
        console.log("  SKIP: no in-band price during entry window");
        skip("no_in_band");
        continue;
      }
      console.log("  Entry at t=" + best.ts + " p=" + best.price + " tokenIdx=" + best.tokenIdx +
        " outcome=" + (outcomes[best.tokenIdx] ?? "?"));

      const favTokenId = tokens[best.tokenIdx];
      const entryTs = best.ts;
      const refPrice = best.price;

      // Outcome
      const outcome = await getFinalOutcome(id, favTokenId);
      if (outcome.won == null) {
        console.log("  SKIP: no final outcome determinable");
        skip("no_outcome");
        continue;
      }
      console.log("  Outcome: " + (outcome.won ? "WON" : "LOST"));

      // DTR check
      const dtr = (new Date(endDate).getTime() / 1000 - entryTs) / 86400;
      console.log("  DTR: " + dtr.toFixed(1) + " days");
      if (dtr < MIN_DTR || dtr > MAX_DTR) { skip("bad_dtr"); continue; }

      // Fill simulation
      const lookStart = entryTs - config.priceLookbackHours * 3600;
      const fillEnd = entryTs + config.fillWindowSeconds;
      let trades: HistoricalTrade[] = [];
      try {
        trades = await fetchTakerTrades(m.conditionId ?? id, lookStart, fillEnd);
      } catch { trades = []; }
      console.log("  Taker trades in window: " + trades.length);

      const feeRate = FEE_RATE;
      const fill = simulateTakerBuy(trades, favTokenId, entryTs, config.fillWindowSeconds, config.budget, feeRate, config.tickSize);

      let fillSource: "taker_print" | "synthetic";
      let avgPrice: number, aip: number, feePaid: number, shares: number, cashSpent: number, fillRatio: number, fillSecs: number;

      if (fill && fill.fillRatio >= config.minFillRatio) {
        fillSource = "taker_print";
        ({ averagePrice: avgPrice, allInPrice: aip, feePaid, shares, cashSpent, fillRatio, fillSeconds: fillSecs } = fill);
        console.log("  Fill via taker prints: aip=" + aip.toFixed(4) + " shares=" + shares.toFixed(2));
      } else {
        const sp = Math.min(0.9999, refPrice + config.tickSize);
        const fps = takerFeePerShare(sp, feeRate);
        aip = sp + fps;
        if (aip < MIN_FAV_PRICE || aip > MAX_FAV_PRICE) { skip("synth_out_of_band"); continue; }
        shares = config.budget / aip;
        cashSpent = shares * aip;
        feePaid = shares * fps;
        avgPrice = sp;
        fillRatio = 1;
        fillSecs = 0;
        fillSource = "synthetic";
        console.log("  Fill synthetic: aip=" + aip.toFixed(4) + " shares=" + shares.toFixed(2));
      }

      const won = outcome.won;
      const pnl = (won ? shares : 0) - cashSpent;

      results.push({
        sport: "political",
        marketId: id,
        conditionId: m.conditionId ?? "",
        slug,
        gameId: null,
        eventStartTime: endDate,
        favoriteOutcome: outcomes[best.tokenIdx] ?? "?",
        favoriteTokenId: favTokenId,
        referencePrice: refPrice,
        averageFillPrice: avgPrice,
        allInPrice: aip,
        feePaid,
        shares,
        cashSpent,
        fillRatio,
        fillSeconds: fillSecs,
        won,
        pnl,
        roi: cashSpent > 0 ? pnl / cashSpent : 0,
        fillSource,
      });
    } catch (e) {
      console.log("  SKIP: " + (e as Error).message);
      skip("api_error");
    }
  }

  // Phase 3: output
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

  console.log("\nBreakdown: " + rows.length + " trades (" + takerRows.length + " taker_print, " + synthRows.length + " synthetic)");
  console.log("Skips: " + JSON.stringify(Object.fromEntries([...skipCounts].sort((a, b) => b[1] - a[1]))));

  console.log("\nNon-replayable gates NOT enforced:");
  console.log("  liquidity 10K-500K (Gamma returns 0 for closed markets)");
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
    counts: { scanned, candidates: candidates.length, executed: rows.length, takerPrint: takerRows.length, synthetic: synthRows.length, skips: Object.fromEntries(skipCounts) },
    nonReplayableGates: ["liquidity_10K_500K", "spread_<2%", "calibrated_edge_>1%", "volume24hr/liquidity_<15", "depth/ask_check"],
    summaries: { all: summarizeBacktest(rows), development: summarizeBacktest(dev), holdout: holdSummary, takerPrint: summarizeBacktest(takerRows), synthetic: summarizeBacktest(synthRows) }, verdict, rows };
  const dir = path.join(process.cwd(), "data", "backtests");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(dir, "political-favorites-" + stamp);
  const csv = [Object.keys(rows[0] ?? {}).join(","), ...rows.map((r) => Object.values(r).map(csvCell).join(","))].join("\n");
  await Promise.all([writeFile(base + ".json", JSON.stringify(report, null, 2), "utf8"), writeFile(base + ".csv", csv, "utf8")]);
  console.log("\nSaved " + base + ".json and .csv");
}

main().catch((e) => { console.error(e); process.exit(1); });