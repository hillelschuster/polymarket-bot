/**
 * LANE B — Post-Final Resolution-Lag Shadow Logger
 * Isolated from the live pipeline. Writes only data/laneb_shadow.json.
 * Usage: npx tsx src/research/laneBShadow.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const DATA_DIR = path.join(process.cwd(), "data");
const SHADOW_FILE = path.join(DATA_DIR, "laneb_shadow.json");
const QUOTE_BUDGET_USD = 25;
const MIN_EXECUTABLE_CASH = 5;
const MIN_WINNER_PRICE = 0.80;
const MAX_ENTRY_PRICE = 0.9995;
const MIN_NET_RETURN = 0.002;
const MAX_PRICE_SAMPLES = 500;
const MAX_WALLET_DETAILS = 250;
const MAX_EVENT_PAGES = 6;
const MAX_TERMINAL_OPPORTUNITIES = 500;
const MAX_RESOLUTION_CHECKS_PER_PASS = 25;

export interface SportsResult {
  slug: string;
  leagueAbbreviation?: string;
  status?: string;
  score?: string;
  period?: string;
  live?: boolean;
  ended?: boolean;
  finished_timestamp?: string;
  finishedTimestamp?: string;
  last_update?: string;
}

interface GammaMarket {
  id?: string;
  conditionId?: string;
  slug?: string;
  question?: string;
  category?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  outcomes?: string[] | string;
  outcomePrices?: string[] | string;
  clobTokenIds?: string[] | string;
}

interface GammaEvent {
  id?: string;
  slug?: string;
  title?: string;
  category?: string;
  active?: boolean;
  closed?: boolean;
  ended?: boolean;
  live?: boolean;
  gameStatus?: string;
  status?: string;
  finishedTimestamp?: string;
  finished_timestamp?: string;
  endDate?: string;
  markets?: GammaMarket[];
}

interface BookLevel {
  price: string;
  size: string;
}

interface OrderBook {
  bids?: BookLevel[];
  asks?: BookLevel[];
}

interface BookMetrics {
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  midpoint: number | null;
  askDepthUsd: number;
  book: OrderBook;
}

interface ExecutableQuote {
  budget: number;
  cashCost: number;
  shares: number;
  averageAsk: number;
  allInPrice: number;
  fee: number;
  netProfitIfWin: number;
  netReturnIfWin: number;
}

export interface LaneBPriceSample {
  time: string;
  bestAsk: number | null;
  bestBid: number | null;
  spread: number | null;
  averageAsk: number | null;
  allInPrice: number | null;
  executableCash: number | null;
  netReturn: number | null;
  askDepthUsd: number;
}

export interface LaneBWalletBuy {
  wallet: string;
  price: number;
  size: number;
  cash: number;
  time: string;
  transactionHash: string | null;
}

export type LaneBStatus = "detected" | "resolved_win" | "resolved_lose" | "invalidated" | "expired";

export interface ShadowOpportunity {
  id: string;
  eventSlug: string;
  marketSlug: string;
  conditionId: string;
  question: string;
  category: string | null;
  finishSource: "sports_ws" | "gamma_finished_timestamp" | "gamma_ended" | "terminal_status";
  gameStatus: string | null;
  score: string | null;
  finishedAt: string;
  detectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  lastResolutionCheckAt: string | null;
  resolutionLagMinutes: number | null;
  detectionLagMinutes: number;
  winningOutcome: string;
  winningTokenId: string;
  confidence: "high" | "medium" | "low";
  bestAskAtDetection: number;
  bestBidAtDetection: number | null;
  spreadAtDetection: number | null;
  averageAskAtDetection: number;
  allInPriceAtDetection: number;
  executableCashAtDetection: number;
  feeRateBps: number | null;
  theoreticalGrossReturn: number;
  theoreticalNetReturn: number;
  theoreticalNetProfit: number;
  priceSamples: LaneBPriceSample[];
  walletBuysAfterFinish: number;
  uniqueWalletBuyersAfterFinish: number;
  walletBuyCashAfterFinish: number;
  walletBuyDetails: LaneBWalletBuy[];
  status: LaneBStatus;
  realizedReturn: number | null;
  shadowPnl: number | null;
}

export interface ShadowLog {
  version: 2;
  opportunities: ShadowOpportunity[];
  lastRun: string;
  stats: {
    totalDetected: number;
    active: number;
    totalResolved: number;
    wins: number;
    losses: number;
    invalidated: number;
    winRate: number;
    avgRealizedReturn: number;
    avgDetectionLagMinutes: number;
    avgResolutionLagMinutes: number;
    totalShadowPnl: number;
  };
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function terminalStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const normalized = status.toLowerCase().replace(/\s+/g, "");
  return ["final", "ft", "ftot", "f/ot", "f/so", "finished", "awarded", "forfeit"].includes(normalized);
}

function invalidStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const normalized = status.toLowerCase().replace(/\s+/g, "");
  return ["canceled", "cancelled", "postponed", "suspended", "notnecessary", "ftnr"].includes(normalized);
}

function emptyLog(): ShadowLog {
  return {
    version: 2,
    opportunities: [],
    lastRun: "",
    stats: {
      totalDetected: 0,
      active: 0,
      totalResolved: 0,
      wins: 0,
      losses: 0,
      invalidated: 0,
      winRate: 0,
      avgRealizedReturn: 0,
      avgDetectionLagMinutes: 0,
      avgResolutionLagMinutes: 0,
      totalShadowPnl: 0,
    },
  };
}

function migrateLegacyLog(raw: any): ShadowLog {
  const log = emptyLog();
  log.lastRun = toIso(raw?.lastRun) ?? "";
  if (!Array.isArray(raw?.opportunities)) return log;

  for (const legacy of raw.opportunities) {
    const marketSlug = String(legacy?.marketSlug ?? legacy?.slug ?? "");
    const winningTokenId = String(legacy?.winningTokenId ?? "");
    if (!marketSlug || !winningTokenId) continue;
    const detectedAt = toIso(legacy?.detectedAt) ?? new Date().toISOString();
    const finishedAt = toIso(legacy?.finishedAt) ?? detectedAt;
    const resolvedAt = toIso(legacy?.resolvedAt);
    const askRaw = Number(legacy?.bestAskAtDetection);
    const ask = Number.isFinite(askRaw) && askRaw > 0 ? askRaw : 1;
    const bidRaw = Number(legacy?.bestBidAtDetection);
    const bid = Number.isFinite(bidRaw) ? bidRaw : null;
    const spreadRaw = Number(legacy?.spreadAtDetection);
    const spread = Number.isFinite(spreadRaw) ? spreadRaw : null;
    const legacyReturn = Number(legacy?.theoreticalReturn);
    const theoreticalReturn = Number.isFinite(legacyReturn) ? legacyReturn : Math.max(0, (1 - ask) / ask);
    const status: LaneBStatus = ["detected", "resolved_win", "resolved_lose", "invalidated", "expired"].includes(String(legacy?.status))
      ? legacy.status as LaneBStatus
      : "detected";
    const executableCash = QUOTE_BUDGET_USD;
    const details: LaneBWalletBuy[] = Array.isArray(legacy?.walletBuyDetails)
      ? legacy.walletBuyDetails.map((buy: any) => {
          const price = Number(buy?.price) || 0;
          const size = Number(buy?.size) || 0;
          return {
            wallet: String(buy?.wallet ?? "").toLowerCase(),
            price: round(price),
            size: round(size, 4),
            cash: round(price * size, 2),
            time: toIso(buy?.time) ?? detectedAt,
            transactionHash: null,
          };
        })
      : [];

    log.opportunities.push({
      id: `legacy:${marketSlug}:${winningTokenId}`,
      eventSlug: String(legacy?.eventSlug ?? marketSlug),
      marketSlug,
      conditionId: String(legacy?.conditionId ?? ""),
      question: String(legacy?.question ?? marketSlug),
      category: legacy?.category == null ? null : String(legacy.category),
      finishSource: "terminal_status",
      gameStatus: null,
      score: null,
      finishedAt,
      detectedAt,
      lastSeenAt: toIso(legacy?.lastSeenAt) ?? detectedAt,
      resolvedAt,
      lastResolutionCheckAt: null,
      resolutionLagMinutes: resolvedAt ? round((new Date(resolvedAt).getTime() - new Date(finishedAt).getTime()) / 60_000, 2) : null,
      detectionLagMinutes: round((new Date(detectedAt).getTime() - new Date(finishedAt).getTime()) / 60_000, 2),
      winningOutcome: String(legacy?.winningOutcome ?? "unknown"),
      winningTokenId,
      confidence: "low",
      bestAskAtDetection: round(ask),
      bestBidAtDetection: bid == null ? null : round(bid),
      spreadAtDetection: spread == null ? null : round(spread),
      averageAskAtDetection: round(ask),
      allInPriceAtDetection: round(ask),
      executableCashAtDetection: executableCash,
      feeRateBps: null,
      theoreticalGrossReturn: round(theoreticalReturn),
      theoreticalNetReturn: round(theoreticalReturn),
      theoreticalNetProfit: round(theoreticalReturn * executableCash, 2),
      priceSamples: [{
        time: detectedAt,
        bestAsk: round(ask),
        bestBid: bid == null ? null : round(bid),
        spread: spread == null ? null : round(spread),
        averageAsk: round(ask),
        allInPrice: round(ask),
        executableCash,
        netReturn: round(theoreticalReturn),
        askDepthUsd: 0,
      }],
      walletBuysAfterFinish: Number(legacy?.walletBuysAfterFinish) || details.length,
      uniqueWalletBuyersAfterFinish: new Set(details.map((buy) => buy.wallet)).size,
      walletBuyCashAfterFinish: round(details.reduce((sum, buy) => sum + buy.cash, 0), 2),
      walletBuyDetails: details.slice(-MAX_WALLET_DETAILS),
      status,
      realizedReturn: status === "resolved_win" ? round(theoreticalReturn) : status === "resolved_lose" ? -1 : null,
      shadowPnl: status === "resolved_win"
        ? round(theoreticalReturn * executableCash, 2)
        : status === "resolved_lose" ? -executableCash : null,
    });
  }
  recalculateStats(log);
  return log;
}

export function loadLaneBLog(): ShadowLog {
  try {
    if (!fs.existsSync(SHADOW_FILE)) return emptyLog();
    const raw = JSON.parse(fs.readFileSync(SHADOW_FILE, "utf8"));
    if (raw?.version === 2 && Array.isArray(raw.opportunities)) return raw as ShadowLog;
    return migrateLegacyLog(raw);
  } catch {
    return emptyLog();
  }
}

function saveLog(log: ShadowLog): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SHADOW_FILE, `${JSON.stringify(log, null, 2)}\n`, "utf8");
}

async function fetchJson<T>(url: string, retries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, {
        headers: { "content-type": "application/json" },
        signal: controller.signal,
      });
      if (response.ok) return response.json() as Promise<T>;
      const body = await response.text();
      if (response.status !== 429 && response.status < 500) throw new Error(`API ${response.status}: ${body}`);
      lastError = new Error(`API ${response.status}: ${body}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function getActiveEvents(): Promise<GammaEvent[]> {
  const events: GammaEvent[] = [];
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const query = new URLSearchParams({
      active: "true",
      closed: "false",
      limit: "100",
      offset: String(page * 100),
      order: "end_date",
      ascending: "true",
    });
    const batch = await fetchJson<GammaEvent[]>(`${GAMMA_API}/events?${query}`);
    events.push(...batch);
    if (batch.length < 100) break;
  }
  return events;
}

async function getEventBySlug(slug: string): Promise<GammaEvent | null> {
  try {
    return await fetchJson<GammaEvent>(`${GAMMA_API}/events/slug/${encodeURIComponent(slug)}`);
  } catch {
    return null;
  }
}

async function getMarketBySlug(slug: string): Promise<GammaMarket | null> {
  try {
    const query = new URLSearchParams({ slug, limit: "1" });
    const markets = await fetchJson<GammaMarket[]>(`${GAMMA_API}/markets?${query}`);
    return markets[0] ?? null;
  } catch {
    return null;
  }
}

async function getBook(tokenId: string): Promise<BookMetrics> {
  const query = new URLSearchParams({ token_id: tokenId });
  const book = await fetchJson<OrderBook>(`${CLOB_API}/book?${query}`);
  const bids = (book.bids ?? [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0)
    .sort((a, b) => b.price - a.price);
  const asks = (book.asks ?? [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.price < 1 && level.size > 0)
    .sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const midpoint = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk;
  const askDepthUsd = asks.reduce((sum, level) => sum + level.price * level.size, 0);
  return {
    bestBid,
    bestAsk,
    spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
    midpoint,
    askDepthUsd,
    book,
  };
}

async function getFeeRateBps(tokenId: string): Promise<number | null> {
  try {
    const response = await fetchJson<{ base_fee: number | string }>(`${CLOB_API}/fee-rate/${encodeURIComponent(tokenId)}`);
    const value = Number(response.base_fee);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function feePerShare(price: number, feeRateBps: number): number {
  return price * (1 - price) * feeRateBps / 10_000;
}

function quoteBook(book: OrderBook, feeRateBps: number, budget: number): ExecutableQuote | null {
  const asks = (book.asks ?? [])
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.price <= MAX_ENTRY_PRICE && level.size > 0)
    .sort((a, b) => a.price - b.price);
  let remaining = budget;
  let shares = 0;
  let notional = 0;
  let fee = 0;
  for (const level of asks) {
    const allInPerShare = level.price + feePerShare(level.price, feeRateBps);
    const take = Math.min(level.size, remaining / allInPerShare);
    if (take <= 0) continue;
    shares += take;
    notional += take * level.price;
    fee += take * feePerShare(level.price, feeRateBps);
    remaining -= take * allInPerShare;
    if (remaining <= 0.001) break;
  }
  const cashCost = notional + fee;
  if (cashCost < MIN_EXECUTABLE_CASH || shares <= 0) return null;
  const netProfitIfWin = shares - cashCost;
  return {
    budget,
    cashCost,
    shares,
    averageAsk: notional / shares,
    allInPrice: cashCost / shares,
    fee,
    netProfitIfWin,
    netReturnIfWin: netProfitIfWin / cashCost,
  };
}

async function getMarketTrades(conditionId: string): Promise<any[]> {
  const trades: any[] = [];
  for (let offset = 0; offset < 1000; offset += 500) {
    const query = new URLSearchParams({
      market: conditionId,
      side: "BUY",
      takerOnly: "true",
      limit: "500",
      offset: String(offset),
    });
    const page = await fetchJson<any[]>(`${DATA_API}/trades?${query}`);
    trades.push(...page);
    if (page.length < 500) break;
  }
  return trades;
}

function resolveFinish(event: GammaEvent, ws: SportsResult | undefined): {
  ended: boolean;
  invalid: boolean;
  finishedAt: string | null;
  source: ShadowOpportunity["finishSource"] | null;
  status: string | null;
  score: string | null;
} {
  const status = ws?.status ?? event.gameStatus ?? event.status ?? null;
  const invalid = invalidStatus(status);
  if (ws?.ended === true) {
    return {
      ended: true,
      invalid,
      finishedAt: toIso(ws.finished_timestamp ?? ws.finishedTimestamp ?? ws.last_update ?? event.finishedTimestamp ?? event.endDate),
      source: "sports_ws",
      status,
      score: ws.score ?? null,
    };
  }
  const gammaFinished = toIso(event.finishedTimestamp ?? event.finished_timestamp);
  if (gammaFinished) {
    return { ended: true, invalid, finishedAt: gammaFinished, source: "gamma_finished_timestamp", status, score: null };
  }
  if (event.ended === true) {
    return { ended: true, invalid, finishedAt: toIso(event.endDate), source: "gamma_ended", status, score: null };
  }
  if (terminalStatus(status)) {
    return { ended: true, invalid, finishedAt: toIso(event.endDate), source: "terminal_status", status, score: null };
  }
  return { ended: false, invalid, finishedAt: null, source: null, status, score: null };
}

function confidenceFor(input: {
  source: ShadowOpportunity["finishSource"];
  winnerReference: number;
  spread: number | null;
  gameStatus: string | null;
}): ShadowOpportunity["confidence"] {
  const definitiveFinish = input.source === "sports_ws" || input.source === "gamma_finished_timestamp";
  const tightEnough = input.spread == null || input.spread <= 0.03;
  if (definitiveFinish && input.winnerReference >= 0.95 && tightEnough && !invalidStatus(input.gameStatus)) return "high";
  if (input.winnerReference >= 0.90 && !invalidStatus(input.gameStatus)) return "medium";
  return "low";
}

function makeSample(now: Date, metrics: BookMetrics, quote: ExecutableQuote | null): LaneBPriceSample {
  return {
    time: now.toISOString(),
    bestAsk: metrics.bestAsk == null ? null : round(metrics.bestAsk),
    bestBid: metrics.bestBid == null ? null : round(metrics.bestBid),
    spread: metrics.spread == null ? null : round(metrics.spread),
    averageAsk: quote == null ? null : round(quote.averageAsk),
    allInPrice: quote == null ? null : round(quote.allInPrice),
    executableCash: quote == null ? null : round(quote.cashCost, 2),
    netReturn: quote == null ? null : round(quote.netReturnIfWin),
    askDepthUsd: round(metrics.askDepthUsd, 2),
  };
}

function walletBuysForToken(trades: any[], tokenId: string, finishedAt: string): LaneBWalletBuy[] {
  const finishTime = new Date(finishedAt).getTime();
  const seen = new Set<string>();
  const buys: LaneBWalletBuy[] = [];
  for (const trade of trades) {
    if (String(trade.asset ?? "") !== tokenId) continue;
    const timestampSeconds = Number(trade.timestamp);
    if (!Number.isFinite(timestampSeconds) || timestampSeconds * 1000 <= finishTime) continue;
    const wallet = String(trade.proxyWallet ?? "").toLowerCase();
    const transactionHash = trade.transactionHash ? String(trade.transactionHash) : null;
    const key = transactionHash ?? `${wallet}|${timestampSeconds}|${trade.price}|${trade.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const price = Number(trade.price) || 0;
    const size = Number(trade.size) || 0;
    buys.push({
      wallet,
      price: round(price),
      size: round(size, 4),
      cash: round(price * size, 2),
      time: new Date(timestampSeconds * 1000).toISOString(),
      transactionHash,
    });
  }
  return buys.sort((a, b) => a.time.localeCompare(b.time));
}

function updateWalletStats(opportunity: ShadowOpportunity, buys: LaneBWalletBuy[]): void {
  opportunity.walletBuysAfterFinish = buys.length;
  opportunity.uniqueWalletBuyersAfterFinish = new Set(buys.map((buy) => buy.wallet)).size;
  opportunity.walletBuyCashAfterFinish = round(buys.reduce((sum, buy) => sum + buy.cash, 0), 2);
  opportunity.walletBuyDetails = buys.slice(-MAX_WALLET_DETAILS);
}

function recalculateStats(log: ShadowLog): void {
  const resolved = log.opportunities.filter((opportunity) => opportunity.status === "resolved_win" || opportunity.status === "resolved_lose");
  const wins = resolved.filter((opportunity) => opportunity.status === "resolved_win");
  const losses = resolved.filter((opportunity) => opportunity.status === "resolved_lose");
  const realizedReturns = resolved.map((opportunity) => opportunity.realizedReturn ?? 0);
  const resolutionLags = resolved.map((opportunity) => opportunity.resolutionLagMinutes).filter((value): value is number => value != null);
  log.stats = {
    totalDetected: log.opportunities.length,
    active: log.opportunities.filter((opportunity) => opportunity.status === "detected").length,
    totalResolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    invalidated: log.opportunities.filter((opportunity) => opportunity.status === "invalidated").length,
    winRate: resolved.length ? round(wins.length / resolved.length) : 0,
    avgRealizedReturn: realizedReturns.length ? round(realizedReturns.reduce((sum, value) => sum + value, 0) / realizedReturns.length) : 0,
    avgDetectionLagMinutes: log.opportunities.length
      ? round(log.opportunities.reduce((sum, opportunity) => sum + opportunity.detectionLagMinutes, 0) / log.opportunities.length, 2)
      : 0,
    avgResolutionLagMinutes: resolutionLags.length
      ? round(resolutionLags.reduce((sum, value) => sum + value, 0) / resolutionLags.length, 2)
      : 0,
    totalShadowPnl: round(resolved.reduce((sum, opportunity) => sum + (opportunity.shadowPnl ?? 0), 0), 2),
  };
}

export async function runLaneBScan(sportsResults: Iterable<SportsResult> = []): Promise<ShadowLog> {
  const log = loadLaneBLog();
  const now = new Date();
  const wsBySlug = new Map<string, SportsResult>();
  for (const result of sportsResults) {
    if (result.slug) wsBySlug.set(result.slug, result);
  }

  console.log(`[${now.toISOString()}] Lane B scan`);
  const events = await getActiveEvents();
  const eventBySlug = new Map(events.filter((event) => event.slug).map((event) => [event.slug!, event]));
  for (const slug of wsBySlug.keys()) {
    if (!eventBySlug.has(slug)) {
      const event = await getEventBySlug(slug);
      if (event) eventBySlug.set(slug, event);
    }
  }

  const opportunityById = new Map(log.opportunities.map((opportunity) => [opportunity.id, opportunity]));
  const opportunityByMarketToken = new Map(log.opportunities.map((opportunity) => [`${opportunity.marketSlug}:${opportunity.winningTokenId}`, opportunity]));
  const marketCache = new Map<string, GammaMarket>();
  const tradeCache = new Map<string, any[]>();
  let newDetections = 0;
  let updated = 0;

  for (const event of eventBySlug.values()) {
    const eventSlug = event.slug ?? "";
    if (!eventSlug) continue;
    const finish = resolveFinish(event, wsBySlug.get(eventSlug));
    if (!finish.ended || !finish.finishedAt || !finish.source || finish.invalid) continue;
    const finishedAtMs = new Date(finish.finishedAt).getTime();
    if (!Number.isFinite(finishedAtMs) || finishedAtMs > now.getTime() + 60_000) continue;
    const markets = Array.isArray(event.markets) ? event.markets : [];

    for (const market of markets) {
      const marketSlug = market.slug ?? "";
      const conditionId = market.conditionId ?? "";
      if (!marketSlug || !conditionId || market.closed === true || market.active === false || market.acceptingOrders === false) continue;
      marketCache.set(marketSlug, market);
      const outcomes = parseStringArray(market.outcomes);
      const tokenIds = parseStringArray(market.clobTokenIds);
      const gammaPrices = parseStringArray(market.outcomePrices).map(Number);
      if (!tokenIds.length || tokenIds.length !== outcomes.length) continue;

      const books = await Promise.all(tokenIds.map(async (tokenId) => {
        try {
          return await getBook(tokenId);
        } catch {
          return null;
        }
      }));
      const references = tokenIds.map((_, index) => books[index]?.midpoint ?? gammaPrices[index] ?? 0);
      const sortedIndexes = references.map((_, index) => index).sort((a, b) => references[b] - references[a]);
      const winnerIndex = sortedIndexes[0];
      const runnerUpIndex = sortedIndexes[1];
      const winnerReference = references[winnerIndex] ?? 0;
      const runnerUpReference = runnerUpIndex == null ? 0 : references[runnerUpIndex] ?? 0;
      const winningTokenId = tokenIds[winnerIndex];
      const metrics = books[winnerIndex];
      if (!metrics || metrics.bestAsk == null || !winningTokenId) continue;
      if (winnerReference < MIN_WINNER_PRICE || winnerReference - runnerUpReference < 0.35) continue;

      const feeRateBps = await getFeeRateBps(winningTokenId);
      const quote = quoteBook(metrics.book, feeRateBps ?? 30, QUOTE_BUDGET_USD);
      const id = `${conditionId}:${winningTokenId}`;
      const existing = opportunityById.get(id) ?? opportunityByMarketToken.get(`${marketSlug}:${winningTokenId}`);
      const qualifies = metrics.bestAsk <= MAX_ENTRY_PRICE
        && quote != null
        && quote.netReturnIfWin >= MIN_NET_RETURN;
      if (!existing && !qualifies) continue;

      let marketTrades = tradeCache.get(conditionId);
      if (!marketTrades) {
        try {
          marketTrades = await getMarketTrades(conditionId);
        } catch {
          marketTrades = [];
        }
        tradeCache.set(conditionId, marketTrades);
      }
      const buys = walletBuysForToken(marketTrades, winningTokenId, finish.finishedAt);
      const sample = makeSample(now, metrics, quote);

      if (existing) {
        existing.lastSeenAt = now.toISOString();
        existing.gameStatus = finish.status;
        existing.score = finish.score;
        existing.priceSamples.push(sample);
        if (existing.priceSamples.length > MAX_PRICE_SAMPLES) existing.priceSamples.splice(0, existing.priceSamples.length - MAX_PRICE_SAMPLES);
        updateWalletStats(existing, buys);
        updated++;
        continue;
      }

      if (!quote) continue;
      const detectionLagMinutes = (now.getTime() - finishedAtMs) / 60_000;
      const opportunity: ShadowOpportunity = {
        id,
        eventSlug,
        marketSlug,
        conditionId,
        question: market.question ?? event.title ?? marketSlug,
        category: market.category ?? event.category ?? null,
        finishSource: finish.source,
        gameStatus: finish.status,
        score: finish.score,
        finishedAt: finish.finishedAt,
        detectedAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        resolvedAt: null,
        lastResolutionCheckAt: null,
        resolutionLagMinutes: null,
        detectionLagMinutes: round(detectionLagMinutes, 2),
        winningOutcome: outcomes[winnerIndex] ?? `outcome-${winnerIndex}`,
        winningTokenId,
        confidence: confidenceFor({ source: finish.source, winnerReference, spread: metrics.spread, gameStatus: finish.status }),
        bestAskAtDetection: round(metrics.bestAsk),
        bestBidAtDetection: metrics.bestBid == null ? null : round(metrics.bestBid),
        spreadAtDetection: metrics.spread == null ? null : round(metrics.spread),
        averageAskAtDetection: round(quote.averageAsk),
        allInPriceAtDetection: round(quote.allInPrice),
        executableCashAtDetection: round(quote.cashCost, 2),
        feeRateBps,
        theoreticalGrossReturn: round((1 - quote.averageAsk) / quote.averageAsk),
        theoreticalNetReturn: round(quote.netReturnIfWin),
        theoreticalNetProfit: round(quote.netProfitIfWin, 2),
        priceSamples: [sample],
        walletBuysAfterFinish: 0,
        uniqueWalletBuyersAfterFinish: 0,
        walletBuyCashAfterFinish: 0,
        walletBuyDetails: [],
        status: "detected",
        realizedReturn: null,
        shadowPnl: null,
      };
      updateWalletStats(opportunity, buys);
      log.opportunities.push(opportunity);
      opportunityById.set(id, opportunity);
      opportunityByMarketToken.set(`${marketSlug}:${winningTokenId}`, opportunity);
      newDetections++;
      console.log(`  NEW ${marketSlug} | ${opportunity.winningOutcome} | all-in ${opportunity.allInPriceAtDetection.toFixed(4)} | net ${(opportunity.theoreticalNetReturn * 100).toFixed(2)}% | ${opportunity.confidence}`);
    }
  }

  let newResolutions = 0;
  const pendingResolution = log.opportunities
    .filter((opportunity) => opportunity.status === "detected" || opportunity.status === "expired")
    .sort((a, b) => (a.lastResolutionCheckAt ?? "").localeCompare(b.lastResolutionCheckAt ?? ""))
    .slice(0, MAX_RESOLUTION_CHECKS_PER_PASS);
  for (const opportunity of pendingResolution) {
    opportunity.lastResolutionCheckAt = now.toISOString();
    let market = marketCache.get(opportunity.marketSlug);
    if (!market) {
      market = await getMarketBySlug(opportunity.marketSlug) ?? undefined;
      if (market) marketCache.set(opportunity.marketSlug, market);
    }
    if (!market) continue;

    if (market.closed !== true) {
      if (market.active === false) opportunity.status = "expired";
      continue;
    }

    const tokenIds = parseStringArray(market.clobTokenIds);
    const prices = parseStringArray(market.outcomePrices).map(Number);
    const index = tokenIds.indexOf(opportunity.winningTokenId);
    if (index < 0 || !Number.isFinite(prices[index])) {
      opportunity.status = "invalidated";
      newResolutions++;
      continue;
    }

    const settlementPrice = prices[index];
    opportunity.resolvedAt = now.toISOString();
    opportunity.resolutionLagMinutes = round((now.getTime() - new Date(opportunity.finishedAt).getTime()) / 60_000, 2);
    if (settlementPrice >= 0.99) {
      opportunity.status = "resolved_win";
      opportunity.realizedReturn = opportunity.theoreticalNetReturn;
      opportunity.shadowPnl = opportunity.theoreticalNetProfit;
    } else if (settlementPrice <= 0.01) {
      opportunity.status = "resolved_lose";
      opportunity.realizedReturn = -1;
      opportunity.shadowPnl = -opportunity.executableCashAtDetection;
    } else {
      opportunity.status = "invalidated";
      opportunity.realizedReturn = null;
      opportunity.shadowPnl = null;
    }
    newResolutions++;
    console.log(`  RESOLVED ${opportunity.marketSlug} -> ${opportunity.status} (${settlementPrice.toFixed(3)})`);
  }

  const activeOpportunities = log.opportunities.filter((opportunity) => opportunity.status === "detected" || opportunity.status === "expired");
  const terminalOpportunities = log.opportunities
    .filter((opportunity) => opportunity.status !== "detected" && opportunity.status !== "expired")
    .sort((a, b) => (b.resolvedAt ?? b.lastSeenAt).localeCompare(a.resolvedAt ?? a.lastSeenAt));
  if (terminalOpportunities.length > MAX_TERMINAL_OPPORTUNITIES) {
    log.opportunities = [...activeOpportunities, ...terminalOpportunities.slice(0, MAX_TERMINAL_OPPORTUNITIES)]
      .sort((a, b) => a.detectedAt.localeCompare(b.detectedAt));
    console.log(`  Pruned ${terminalOpportunities.length - MAX_TERMINAL_OPPORTUNITIES} old terminal opportunities.`);
  }

  log.lastRun = now.toISOString();
  recalculateStats(log);
  saveLog(log);
  console.log(`  Done: ${newDetections} new, ${updated} updated, ${newResolutions} resolved; ${log.stats.active} active, shadow PnL $${log.stats.totalShadowPnl.toFixed(2)}`);
  return log;
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isDirectRun()) {
  runLaneBScan().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
