// Public Polymarket market-data clients. No authentication or execution.
import { quoteBuyWithCash, quoteSellSharesExact } from "../lib/executableQuotes.js";
import type { FeeModel } from "./marketFees.js";
export const DATA_API = "https://data-api.polymarket.com";
export const GAMMA_API = "https://gamma-api.polymarket.com";
export const CLOB_API = "https://clob.polymarket.com";

// Gamma is the shared-IP bottleneck. Pace only Gamma so CLOB executable-book
// requests and already-paced wallet polling remain concurrent/fresh.
const GAMMA_HOST = new URL(GAMMA_API).host;
const GAMMA_MIN_GAP_MS = Number(process.env.POLYMARKET_MIN_GAP_MS ?? 150);
let gammaLastRequestAt = 0;
let gammaQueue: Promise<unknown> = Promise.resolve();

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function pacedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  if (new URL(url).host !== GAMMA_HOST) return fetchWithTimeout(url, init, timeoutMs);

  const run = gammaQueue.then(async () => {
    const wait = gammaLastRequestAt + GAMMA_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    gammaLastRequestAt = Date.now();
    return fetchWithTimeout(url, init, timeoutMs);
  });
  gammaQueue = run.then(() => undefined, () => undefined);
  return run;
}

export class FetchError extends Error {
  constructor(public status: number, public body: string) {
    super(`Polymarket API failed: ${status} ${body}`);
  }
}

export async function fetchJson<T>(url: string, opts: RequestInit = {}, retries = 4): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers as Record<string, string>) };
  if (process.env.POLYMARKET_API_KEY) headers["x-api-key"] = process.env.POLYMARKET_API_KEY;
  let attempt = 0;
  while (true) {
    try {
      const res = await pacedFetch(url, { ...opts, headers }, 10_000);
      if (res.ok) return res.json() as Promise<T>;
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        // 429s get a longer floor so the shared API can breathe; respect Retry-After if given.
        const base = res.status === 429 ? 1500 : 1000;
        const wait = retryAfter > 0 ? retryAfter * 1000 : Math.max(base, Math.min(2 ** attempt * 1000, 8000));
        console.warn(`fetchJson: ${res.status} on ${url} (attempt ${attempt + 1}/${retries}); backing off ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        attempt++;
        continue;
      }
      throw new FetchError(res.status, await res.text());
    } catch (e) {
      if (e instanceof FetchError) throw e;
      if (attempt < retries) {
        const wait = Math.min(2 ** attempt * 1000, 8000);
        console.warn(`fetchJson: network error on ${url} (attempt ${attempt + 1}/${retries}); retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        attempt++;
        continue;
      }
      throw e;
    }
  }
}

/** Get current prices for one or more token IDs from CLOB. */
export async function getPrices(tokenIds: string[]): Promise<{ token_id: string; price: string }[]> {
  if (!tokenIds.length) return [];
  const qs = new URLSearchParams();
  tokenIds.forEach((id) => qs.append("token_ids", id));
  return fetchJson<{ token_id: string; price: string }[]>(`${CLOB_API}/prices?${qs}`);
}

export interface OrderLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  market: string;
  asset_id: string;
  timestamp?: string;
  bids: OrderLevel[];
  asks: OrderLevel[];
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
  last_trade_price?: string;
}

export interface BuyQuote {
  shares: number;
  cashCost: number;
  averageAsk: number;
  fee: number;
  allInPrice: number;
  bestBid: number | null;
  bestAsk: number;
  spread: number | null;
}

export interface SellQuote {
  shares: number;
  cashProceeds: number;
  averageBid: number;
  fee: number;
  netPrice: number;
  bestBid: number;
  bestAsk: number | null;
  spread: number | null;
}

export async function getOrderBook(tokenId: string): Promise<OrderBook> {
  const qs = new URLSearchParams({ token_id: tokenId });
  return fetchJson<OrderBook>(`${CLOB_API}/book?${qs}`);
}

export async function getFeeRateBps(tokenId: string): Promise<number> {
  const raw = await fetchJson<{ base_fee: number | string }>(`${CLOB_API}/fee-rate/${encodeURIComponent(tokenId)}`);
  const rate = Number(raw.base_fee);
  if (!Number.isFinite(rate) || rate < 0) throw new Error(`Invalid fee rate for token ${tokenId}`);
  return rate;
}

export function takerFeePerShare(price: number, feeRateBps: number): number {
  return price * (1 - price) * (feeRateBps / 10_000);
}

function bookEdges(book: OrderBook): { bestBid: number | null; bestAsk: number | null; spread: number | null } {
  const bids = (book.bids ?? []).map((x) => Number(x.price)).filter(Number.isFinite).sort((a, b) => b - a);
  const asks = (book.asks ?? []).map((x) => Number(x.price)).filter(Number.isFinite).sort((a, b) => a - b);
  const bestBid = bids[0] ?? null;
  const bestAsk = asks[0] ?? null;
  return { bestBid, bestAsk, spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null };
}

export function quoteBuyShares(book: OrderBook, feeRateBps: number, targetShares: number): BuyQuote | null {
  if (!(targetShares > 0)) return null;
  const asks = [...(book.asks ?? [])]
    .map((x) => ({ price: Number(x.price), size: Number(x.size) }))
    .filter((x) => Number.isFinite(x.price) && Number.isFinite(x.size) && x.price > 0 && x.size > 0)
    .sort((a, b) => a.price - b.price);
  if (!asks.length) return null;

  let remaining = targetShares;
  let notional = 0;
  let fee = 0;
  for (const level of asks) {
    const take = Math.min(level.size, remaining);
    notional += take * level.price;
    fee += take * takerFeePerShare(level.price, feeRateBps);
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-6) return null;

  const minOrder = Number(book.min_order_size ?? 0);
  if (Number.isFinite(minOrder) && targetShares < minOrder) return null;
  const edges = bookEdges(book);
  if (edges.bestAsk == null) return null;
  const cashCost = notional + fee;
  return {
    shares: targetShares,
    cashCost,
    averageAsk: notional / targetShares,
    fee,
    allInPrice: cashCost / targetShares,
    bestBid: edges.bestBid,
    bestAsk: edges.bestAsk,
    spread: edges.spread,
  };
}

export function quoteBuyCash(book: OrderBook, feeRateBps: number, cashBudget: number): BuyQuote | null {
  if (!(cashBudget > 0)) return null;
  const asks = [...(book.asks ?? [])]
    .map((x) => ({ price: Number(x.price), size: Number(x.size) }))
    .filter((x) => Number.isFinite(x.price) && Number.isFinite(x.size) && x.price > 0 && x.size > 0)
    .sort((a, b) => a.price - b.price);
  if (!asks.length) return null;

  let remainingCash = cashBudget;
  let shares = 0;
  let notional = 0;
  let fee = 0;
  for (const level of asks) {
    const feePerShare = takerFeePerShare(level.price, feeRateBps);
    const allInPerShare = level.price + feePerShare;
    const take = Math.min(level.size, remainingCash / allInPerShare);
    shares += take;
    notional += take * level.price;
    fee += take * feePerShare;
    remainingCash -= take * allInPerShare;
    if (remainingCash <= 1e-7) break;
  }
  if (remainingCash > 0.005 || shares <= 0) return null;

  const minOrder = Number(book.min_order_size ?? 0);
  if (Number.isFinite(minOrder) && shares < minOrder) return null;
  const edges = bookEdges(book);
  if (edges.bestAsk == null) return null;
  const cashCost = notional + fee;
  return {
    shares,
    cashCost,
    averageAsk: notional / shares,
    fee,
    allInPrice: cashCost / shares,
    bestBid: edges.bestBid,
    bestAsk: edges.bestAsk,
    spread: edges.spread,
  };
}

export function quoteSellShares(book: OrderBook, feeRateBps: number, targetShares: number): SellQuote | null {
  if (!(targetShares > 0)) return null;
  const bids = [...(book.bids ?? [])]
    .map((x) => ({ price: Number(x.price), size: Number(x.size) }))
    .filter((x) => Number.isFinite(x.price) && Number.isFinite(x.size) && x.price > 0 && x.size > 0)
    .sort((a, b) => b.price - a.price);
  if (!bids.length) return null;

  let remaining = targetShares;
  let notional = 0;
  let fee = 0;
  for (const level of bids) {
    const take = Math.min(level.size, remaining);
    notional += take * level.price;
    fee += take * takerFeePerShare(level.price, feeRateBps);
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-6) return null;

  const edges = bookEdges(book);
  if (edges.bestBid == null) return null;
  const cashProceeds = notional - fee;
  return {
    shares: targetShares,
    cashProceeds,
    averageBid: notional / targetShares,
    fee,
    netPrice: cashProceeds / targetShares,
    bestBid: edges.bestBid,
    bestAsk: edges.bestAsk,
    spread: edges.spread,
  };
}

export async function getExecutableBuyQuote(tokenId: string, cashBudget: number, feeModel?: FeeModel): Promise<BuyQuote | null> {
  if (feeModel) {
    const book = await getOrderBook(tokenId);
    return quoteBuyWithCash(book, feeModel, cashBudget);
  }
  const [book, feeRateBps] = await Promise.all([getOrderBook(tokenId), getFeeRateBps(tokenId)]);
  return quoteBuyCash(book, feeRateBps, cashBudget);
}

export async function getExecutableSellQuote(tokenId: string, shares: number, feeModel?: FeeModel): Promise<SellQuote | null> {
  if (feeModel) {
    const book = await getOrderBook(tokenId);
    return quoteSellSharesExact(book, feeModel, shares);
  }
  const [book, feeRateBps] = await Promise.all([getOrderBook(tokenId), getFeeRateBps(tokenId)]);
  return quoteSellShares(book, feeRateBps, shares);
}

function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return []; }
  }
  return [];
}

export interface GammaMarket {
  id: string;
  conditionId: string | null;
  question: string | null;
  slug: string | null;
  category: string | null;
  description: string | null;
  resolutionSource: string | null;
  eventId: string | null;
  eventSlug: string | null;
  outcomes: string[];
  outcomePrices: number[];
  clobTokenIds: string[];
  liquidity: number;
  spread: number;
  volume24hr: number;
  volume: number;
  endDate: string | null;
  acceptingOrders: boolean;
  active: boolean;
  closed: boolean;
}

function normalizeGammaMarket(m: any): GammaMarket {
  const event = Array.isArray(m.events) ? m.events[0] : null;
  return {
    id: String(m.id ?? ""),
    conditionId: m.conditionId ? String(m.conditionId) : null,
    question: m.question ?? null,
    slug: m.slug ?? null,
    category: m.category ?? null,
    description: m.description ?? null,
    resolutionSource: m.resolutionSource ?? event?.resolutionSource ?? null,
    eventId: event?.id != null ? String(event.id) : null,
    eventSlug: event?.slug ?? null,
    outcomes: parseList(m.outcomes),
    outcomePrices: parseList(m.outcomePrices).map(Number),
    clobTokenIds: parseList(m.clobTokenIds),
    liquidity: Number(m.liquidityNum ?? m.liquidity ?? 0),
    spread: Number(m.spread ?? 0),
    volume24hr: Number(m.volume24hr ?? 0),
    volume: Number(m.volumeNum ?? m.volume ?? 0),
    endDate: m.endDate ?? null,
    acceptingOrders: m.acceptingOrders !== false,
    active: m.active !== false,
    closed: m.closed === true,
  };
}

export interface MarketBySlugOpts {
  /** Also query closed=true when the market isn't found in the default (open) endpoint. */
  includeClosed?: boolean;
  /** Use the persistent 15-minute cache. Intended only for monitor metadata enrichment. */
  cache?: boolean;
}

// Persistent cache is opt-in: monitorTrades can reuse static-ish metadata without
// feeding stale 15-minute market state into scoreTrades or resolution logic.
const MARKET_CACHE_TTL_MS = Number(process.env.MARKET_CACHE_TTL_MS ?? 15 * 60 * 1000);
const marketCache = new Map<string, { ts: number; market: GammaMarket | null }>();

export async function getMarketBySlug(slug: string, opts: MarketBySlugOpts = {}): Promise<GammaMarket | null> {
  const includeClosed = opts.includeClosed ?? true;
  const useCache = opts.cache ?? false;
  const key = `${slug}|${includeClosed ? "c" : "o"}`;
  if (useCache) {
    const hit = marketCache.get(key);
    if (hit && Date.now() - hit.ts < MARKET_CACHE_TTL_MS) return hit.market;
  }

  const qs = new URLSearchParams({ slug, limit: "1" });
  const arr = await fetchJson<any[]>(`${GAMMA_API}/markets?${qs}`);
  const m = Array.isArray(arr) ? arr[0] : null;
  let result = m ? normalizeGammaMarket(m) : null;
  // Fallback: Gamma removes resolved markets from the default endpoint.
  // Only retrievable with closed=true. Critical for reviewOutcomes.
  if (!result && includeClosed) {
    const qs2 = new URLSearchParams({ slug, limit: "1", closed: "true" });
    const arr2 = await fetchJson<any[]>(`${GAMMA_API}/markets?${qs2}`);
    const m2 = Array.isArray(arr2) ? arr2[0] : null;
    result = m2 ? normalizeGammaMarket(m2) : null;
  }

  if (useCache) marketCache.set(key, { ts: Date.now(), market: result });
  return result;
}

export interface ActiveMarketOpts {
  limit?: number;
  offset?: number;
  liquidityMin?: number;
  order?: string;
  ascending?: boolean;
}

export async function getActiveMarkets(opts: ActiveMarketOpts = {}): Promise<GammaMarket[]> {
  const qs = new URLSearchParams();
  qs.set("active", "true");
  qs.set("closed", "false");
  qs.set("limit", String(opts.limit ?? 100));
  qs.set("offset", String(opts.offset ?? 0));
  qs.set("order", opts.order ?? "volume24hr");
  qs.set("ascending", String(opts.ascending ?? false));
  if (opts.liquidityMin != null) qs.set("liquidity_num_min", String(opts.liquidityMin));
  const arr = await fetchJson<any[]>(`${GAMMA_API}/markets?${qs}`);
  return Array.isArray(arr) ? arr.map(normalizeGammaMarket) : [];
}

export interface GammaTag {
  id: number;
  label: string;
  slug: string;
}

export async function getTags(): Promise<GammaTag[]> {
  const arr = await fetchJson<any[]>(`${GAMMA_API}/tags`);
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => ({ id: Number(t.id), label: String(t.label ?? ""), slug: String(t.slug ?? "") }));
}

export interface MarketsByTagOpts extends ActiveMarketOpts {
  endDateMin?: string;
}

export async function getMarketsByTag(tagId: number, opts: MarketsByTagOpts = {}): Promise<GammaMarket[]> {
  const qs = new URLSearchParams();
  qs.set("tag_id", String(tagId));
  qs.set("active", "true");
  qs.set("closed", "false");
  qs.set("limit", String(opts.limit ?? 100));
  qs.set("offset", String(opts.offset ?? 0));
  qs.set("order", opts.order ?? "volume24hr");
  qs.set("ascending", String(opts.ascending ?? false));
  if (opts.liquidityMin != null) qs.set("liquidity_num_min", String(opts.liquidityMin));
  if (opts.endDateMin) qs.set("end_date_min", opts.endDateMin);
  const arr = await fetchJson<any[]>(`${GAMMA_API}/markets?${qs}`);
  return Array.isArray(arr) ? arr.map(normalizeGammaMarket) : [];
}
