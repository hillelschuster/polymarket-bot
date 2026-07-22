import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_API, GAMMA_API, fetchJson } from "../adapters/polymarket.js";
import {
  favoriteAtEntry,
  normalizeFeeRate,
  parseStringList,
  simulateTakerBuy,
  summarizeBacktest,
  type BacktestRow,
  type HistoricalTrade,
} from "../lib/sportsBacktest.js";

interface SportsMetadata { sport?: string; tags?: string; }
interface GammaMarketRaw {
  id?: string | number; conditionId?: string; slug?: string; question?: string; closed?: boolean;
  outcomes?: unknown; outcomePrices?: unknown; clobTokenIds?: unknown; gameId?: string | null;
  sportsMarketType?: string | null; line?: number | string | null; eventStartTime?: string | null;
  gameStartTime?: string | null; orderPriceMinTickSize?: number | string | null;
  feeSchedule?: { rate?: number | string | null } | null;
}
interface DataTradeRaw { asset?: string; side?: string; size?: number | string; price?: number | string; timestamp?: number | string; transactionHash?: string; }
interface CandidateMarket {
  sport: string; id: string; conditionId: string; slug: string; question: string; gameId: string | null;
  eventStartTime: string; outcomes: string[]; outcomePrices: number[]; tokenIds: string[];
  winningIndex: number; tickSize: number; feeRate: number;
}
interface Config {
  sports: string[]; start: Date; end: Date; maxMarkets: number; entryMinutesBeforeStart: number;
  priceLookbackHours: number; maxPriceAgeMinutes: number; fillWindowSeconds: number; budget: number;
  minFillRatio: number; minSample: number; concurrency: number;
}
const PAGE_SIZE = 500;
const TRADE_LIMIT = 10_000;
function numberEnv(name: string, fallback: number): number { const value = Number(process.env[name]); return Number.isFinite(value) ? value : fallback; }
function configFromEnv(): Config {
  const start = new Date(process.env.SPORTS_BACKTEST_START ?? "2026-04-01T00:00:00Z");
  const end = new Date(process.env.SPORTS_BACKTEST_END ?? new Date().toISOString());
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error("Invalid SPORTS_BACKTEST_START/END");
  return {
    sports: (process.env.SPORTS_BACKTEST_SPORTS ?? "mlb,tennis").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
    start, end,
    maxMarkets: Math.max(1, Math.floor(numberEnv("SPORTS_BACKTEST_MAX_MARKETS", 500))),
    entryMinutesBeforeStart: Math.max(1, numberEnv("SPORTS_BACKTEST_ENTRY_MINUTES", 60)),
    priceLookbackHours: Math.max(1, numberEnv("SPORTS_BACKTEST_LOOKBACK_HOURS", 6)),
    maxPriceAgeMinutes: Math.max(1, numberEnv("SPORTS_BACKTEST_MAX_PRICE_AGE_MINUTES", 30)),
    fillWindowSeconds: Math.max(1, numberEnv("SPORTS_BACKTEST_FILL_WINDOW_SECONDS", 300)),
    budget: Math.max(1, numberEnv("SPORTS_BACKTEST_BUDGET", 20)),
    minFillRatio: Math.min(1, Math.max(0.5, numberEnv("SPORTS_BACKTEST_MIN_FILL_RATIO", 0.95))),
    minSample: Math.max(30, Math.floor(numberEnv("SPORTS_BACKTEST_MIN_SAMPLE", 300))),
    concurrency: Math.max(1, Math.min(12, Math.floor(numberEnv("SPORTS_BACKTEST_CONCURRENCY", 5)))),
  };
}
function sportMatches(metadataSport: string, wanted: string): boolean {
  const value = metadataSport.toLowerCase();
  if (wanted === "mlb") return value === "mlb" || value.includes("major league baseball") || value === "baseball";
  if (wanted === "tennis") return value.includes("tennis") || ["atp", "wta", "itf"].includes(value);
  return value === wanted || value.includes(wanted);
}
function classifySport(slug: string, sourceSport: string): string | null {
  const value = slug.toLowerCase();
  if (sourceSport === "mlb") return value.startsWith("mlb-") ? "mlb" : null;
  if (sourceSport === "tennis") return value.startsWith("tennis-") || value.startsWith("atp-") || value.startsWith("wta-") ? "tennis" : null;
  return value.startsWith(`${sourceSport}-`) ? sourceSport : null;
}
function parseTerminalWinner(prices: number[]): number | null {
  if (prices.length !== 2) return null;
  if (!prices.every((p) => Number.isFinite(p) && (p <= 0.005 || p >= 0.995))) return null;
  const winners = prices.map((p, index) => ({ p, index })).filter((x) => x.p >= 0.995);
  return winners.length === 1 ? winners[0].index : null;
}
function isMoneyline(raw: GammaMarketRaw, outcomes: string[]): boolean {
  const marketType = String(raw.sportsMarketType ?? "").toLowerCase();
  if (marketType && !marketType.includes("moneyline") && !marketType.includes("winner")) return false;
  if (raw.line != null && raw.line !== "" && Number(raw.line) !== 0) return false;
  const normalized = outcomes.map((x) => x.trim().toLowerCase());
  if (normalized.length !== 2 || (normalized.includes("yes") && normalized.includes("no"))) return false;
  const text = `${raw.slug ?? ""} ${raw.question ?? ""}`.toLowerCase();
  return !/(spread|handicap|over.?under|total points|total games|total sets|correct score|winning margin|first set|second set)/i.test(text);
}
function normalizeMarket(raw: GammaMarketRaw, sourceSport: string, config: Config): CandidateMarket | null {
  const id = String(raw.id ?? ""); const conditionId = String(raw.conditionId ?? ""); const slug = String(raw.slug ?? "");
  if (!id || !conditionId || !slug || raw.closed !== true) return null;
  const sport = classifySport(slug, sourceSport); if (!sport || !config.sports.includes(sport)) return null;
  const outcomes = parseStringList(raw.outcomes); const outcomePrices = parseStringList(raw.outcomePrices).map(Number); const tokenIds = parseStringList(raw.clobTokenIds);
  if (outcomes.length !== 2 || outcomePrices.length !== 2 || tokenIds.length !== 2 || !isMoneyline(raw, outcomes)) return null;
  const winningIndex = parseTerminalWinner(outcomePrices); if (winningIndex == null) return null;
  const eventStartTime = raw.eventStartTime ?? raw.gameStartTime; if (!eventStartTime) return null;
  const eventStart = new Date(eventStartTime); if (!Number.isFinite(eventStart.getTime()) || eventStart < config.start || eventStart > config.end) return null;
  const tick = Number(raw.orderPriceMinTickSize ?? 0.01); const tickSize = Number.isFinite(tick) && tick > 0 ? tick : 0.01;
  return { sport, id, conditionId, slug, question: String(raw.question ?? ""), gameId: raw.gameId ? String(raw.gameId) : null,
    eventStartTime: eventStart.toISOString(), outcomes, outcomePrices, tokenIds, winningIndex, tickSize,
    feeRate: normalizeFeeRate(raw.feeSchedule?.rate, 0.03) };
}
async function fetchClosedMarketsForTag(tagId: string, sourceSport: string, config: Config): Promise<CandidateMarket[]> {
  const rows: CandidateMarket[] = [];
  for (let offset = 0; offset <= 10_000; offset += PAGE_SIZE) {
    const query = new URLSearchParams({ closed: "true", limit: String(PAGE_SIZE), offset: String(offset), tag_id: tagId,
      related_tags: "true", end_date_min: config.start.toISOString(), end_date_max: config.end.toISOString() });
    const page = await fetchJson<GammaMarketRaw[]>(`${GAMMA_API}/markets?${query}`); if (!Array.isArray(page)) break;
    for (const raw of page) { const market = normalizeMarket(raw, sourceSport, config); if (market) rows.push(market); }
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}
function normalizeTrade(raw: DataTradeRaw): HistoricalTrade | null {
  const asset = String(raw.asset ?? ""); const side = String(raw.side ?? ""); const size = Number(raw.size); const price = Number(raw.price); const timestamp = Number(raw.timestamp);
  if (!asset || !side || !(size > 0) || !(price > 0 && price < 1) || !Number.isFinite(timestamp)) return null;
  return { asset, side, size, price, timestamp };
}
async function fetchTradeWindow(conditionId: string, start: number, end: number): Promise<HistoricalTrade[]> {
  const fetchPage = async (offset: number): Promise<DataTradeRaw[]> => {
    const query = new URLSearchParams({ market: conditionId, limit: String(TRADE_LIMIT), offset: String(offset), takerOnly: "true" });
    const raw = await fetchJson<DataTradeRaw[]>(`${DATA_API}/trades?${query}`);
    return Array.isArray(raw) ? raw : [];
  };
  const first = await fetchPage(0);
  const second = first.length >= TRADE_LIMIT ? await fetchPage(TRADE_LIMIT) : [];
  if (second.length >= TRADE_LIMIT) throw new Error("market exceeds Data API 20,000-trade retrieval limit");
  const unique = new Map<string, HistoricalTrade>();
  for (const raw of [...first, ...second]) {
    const trade = normalizeTrade(raw);
    if (!trade || trade.timestamp < start || trade.timestamp > end) continue;
    const key = `${raw.transactionHash ?? ""}|${trade.timestamp}|${trade.asset}|${trade.side}|${trade.price}|${trade.size}`;
    unique.set(key, trade);
  }
  return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
}
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length); let cursor = 0;
  async function worker(): Promise<void> { while (true) { const index = cursor++; if (index >= items.length) return; output[index] = await fn(items[index], index); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker())); return output;
}
function csvCell(value: unknown): string { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
function rowsToCsv(rows: BacktestRow[]): string {
  const keys = Object.keys(rows[0] ?? {}) as (keyof BacktestRow)[]; if (!keys.length) return "";
  return [keys.join(","), ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(","))].join("\n");
}
function formatPct(value: number): string { return `${(value * 100).toFixed(2)}%`; }
function printSummary(label: string, rows: BacktestRow[]): void {
  const summary = summarizeBacktest(rows);
  console.log(`${label.padEnd(12)} n=${String(summary.n).padStart(3)} days=${String(summary.independentDays).padStart(3)} win=${formatPct(summary.winRate).padStart(7)} ROI=${formatPct(summary.roi).padStart(8)} PnL=$${summary.pnl.toFixed(2).padStart(8)} CI=[${formatPct(summary.ci95Low)}, ${formatPct(summary.ci95High)}]`);
}
async function main(): Promise<void> {
  const config = configFromEnv();
  console.log(`Sports favorites backtest: fixed ${config.entryMinutesBeforeStart}-minute pregame entry, historical taker-print execution proxy`);
  console.log(JSON.stringify({ ...config, start: config.start.toISOString(), end: config.end.toISOString() }, null, 2));
  const metadata = await fetchJson<SportsMetadata[]>(`${GAMMA_API}/sports`); if (!Array.isArray(metadata)) throw new Error("Gamma /sports returned invalid data");
  const tagSources: { tagId: string; sport: string }[] = [];
  for (const wanted of config.sports) {
    const matching = metadata.filter((row) => sportMatches(String(row.sport ?? ""), wanted));
    for (const row of matching) for (const tagId of parseStringList(row.tags)) tagSources.push({ tagId, sport: wanted });
  }
  const uniqueTagSources = [...new Map(tagSources.map((x) => [`${x.tagId}|${x.sport}`, x])).values()];
  if (!uniqueTagSources.length) throw new Error(`No Gamma sports tags found for ${config.sports.join(", ")}`);
  const discovered = (await mapLimit(uniqueTagSources, 3, (source) => fetchClosedMarketsForTag(source.tagId, source.sport, config))).flat();
  const byId = new Map(discovered.map((market) => [market.id, market]));
  const eligible = [...byId.values()].sort((a, b) => Date.parse(a.eventStartTime) - Date.parse(b.eventStartTime));
  const byGame = new Map<string, CandidateMarket>();
  for (const market of eligible) { const key = market.gameId ?? `${market.sport}|${market.eventStartTime}|${market.slug}`; if (!byGame.has(key)) byGame.set(key, market); }
  const independent = [...byGame.values()].sort((a, b) => Date.parse(a.eventStartTime) - Date.parse(b.eventStartTime));
  const selected = independent.slice(-config.maxMarkets);
  console.log(`Discovered ${discovered.length}; eligible unique markets ${eligible.length}; independent games ${independent.length}; testing ${selected.length}.`);
  const skipCounts = new Map<string, number>(); const skip = (reason: string): null => { skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1); return null; };
  let completed = 0;
  const processed = await mapLimit(selected, config.concurrency, async (market): Promise<BacktestRow | null> => {
    try {
      const gameStartTs = Math.floor(Date.parse(market.eventStartTime) / 1000); const entryTs = gameStartTs - config.entryMinutesBeforeStart * 60;
      const trades = await fetchTradeWindow(market.conditionId, entryTs - config.priceLookbackHours * 3600, entryTs + config.fillWindowSeconds);
      const favorite = favoriteAtEntry(trades, market.tokenIds, entryTs, config.maxPriceAgeMinutes * 60); if (!favorite) return skip("no_recent_reference_price");
      const fill = simulateTakerBuy(trades, favorite.tokenId, entryTs, config.fillWindowSeconds, config.budget, market.feeRate, market.tickSize);
      if (!fill) return skip("no_buy_print_after_entry"); if (fill.fillRatio < config.minFillRatio) return skip("insufficient_fill");
      if (fill.allInPrice < 0.65 || fill.allInPrice > 0.80) return skip("outside_65_80");
      const won = favorite.outcomeIndex === market.winningIndex; const payout = won ? fill.shares : 0; const pnl = payout - fill.cashSpent;
      return { sport: market.sport, marketId: market.id, conditionId: market.conditionId, slug: market.slug, gameId: market.gameId,
        eventStartTime: market.eventStartTime, favoriteOutcome: market.outcomes[favorite.outcomeIndex], favoriteTokenId: favorite.tokenId,
        referencePrice: favorite.referencePrice, averageFillPrice: fill.averagePrice, allInPrice: fill.allInPrice, feePaid: fill.feePaid,
        shares: fill.shares, cashSpent: fill.cashSpent, fillRatio: fill.fillRatio, fillSeconds: fill.fillSeconds, won, pnl, roi: pnl / fill.cashSpent };
    } catch (error) { console.warn(`SKIP ${market.slug}: ${(error as Error).message}`); return skip("api_error"); }
    finally { completed++; if (completed % 25 === 0 || completed === selected.length) console.log(`Processed ${completed}/${selected.length}`); }
  });
  const rows = processed.filter((row): row is BacktestRow => row != null).sort((a, b) => Date.parse(a.eventStartTime) - Date.parse(b.eventStartTime));
  const developmentCount = Math.floor(rows.length * 0.7); const development = rows.slice(0, developmentCount); const holdout = rows.slice(developmentCount);
  const coverage = selected.length ? rows.length / selected.length : 0;
  console.log("\n=== RESULTS ==="); printSummary("ALL", rows); printSummary("DEVELOPMENT", development); printSummary("HOLDOUT", holdout);
  for (const sport of config.sports) printSummary(sport.toUpperCase(), rows.filter((row) => row.sport === sport));
  for (const [lo, hi] of [[0.65, 0.70], [0.70, 0.75], [0.75, 0.800001]]) printSummary(`${lo.toFixed(2)}-${Math.min(hi, 0.80).toFixed(2)}`, rows.filter((row) => row.allInPrice >= lo && row.allInPrice < hi));
  console.log(`Coverage: ${rows.length}/${selected.length} = ${formatPct(coverage)}`); console.log("Skips:", Object.fromEntries([...skipCounts.entries()].sort((a, b) => b[1] - a[1])));
  const holdoutSummary = summarizeBacktest(holdout); let verdict: string;
  if (rows.length < config.minSample || holdout.length < Math.ceil(config.minSample * 0.3)) verdict = "INCONCLUSIVE_SAMPLE";
  else if (coverage < 0.5) verdict = "INCONCLUSIVE_LOW_COVERAGE";
  else if (holdoutSummary.ci95Low > 0) verdict = "PASS_POSITIVE_HOLDOUT";
  else if (holdoutSummary.ci95High < 0) verdict = "FAIL_NEGATIVE_HOLDOUT";
  else verdict = "INCONCLUSIVE_EDGE_NOT_SEPARATED_FROM_ZERO";
  console.log(`VERDICT: ${verdict}`);
  const report = { generatedAt: new Date().toISOString(), methodology: {
    discovery: "all closed MLB/tennis moneyline markets from Gamma sports tags", entry: `${config.entryMinutesBeforeStart} minutes before eventStartTime`,
    referencePrice: `freshest market trade within ${config.maxPriceAgeMinutes} minutes before entry; opposite token inferred as complementary`,
    execution: `subsequent taker BUY prints for ${config.fillWindowSeconds}s, one extra tick slippage, market feeSchedule when present`,
    limitations: ["Data API exposes at most 20,000 market trades; denser markets fail closed",
        "trade prints do not reconstruct historical resting order-book depth", "tests direct pregame favorite bias, not wallet-selection alpha", "unfilled markets are skipped and coverage is reported"] },
    config: { ...config, start: config.start.toISOString(), end: config.end.toISOString() },
    counts: { discovered: discovered.length, eligible: eligible.length, independent: independent.length, selected: selected.length, executed: rows.length, coverage, skips: Object.fromEntries(skipCounts) },
    summaries: { all: summarizeBacktest(rows), development: summarizeBacktest(development), holdout: holdoutSummary }, verdict, rows };
  const directory = path.join(process.cwd(), "data", "backtests"); await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-"); const base = path.join(directory, `sports-favorites-${stamp}`);
  await Promise.all([writeFile(`${base}.json`, JSON.stringify(report, null, 2), "utf8"), writeFile(`${base}.csv`, rowsToCsv(rows), "utf8")]);
  console.log(`Saved ${base}.json and .csv`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
