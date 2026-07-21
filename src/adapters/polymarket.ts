// Base HTTP client for Polymarket public APIs. See SPEC §3,§5.
export const DATA_API = "https://data-api.polymarket.com";
export const GAMMA_API = "https://gamma-api.polymarket.com";
export const CLOB_API = "https://clob.polymarket.com";

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
    // ponytail: 10s abort so a slow/hanging upstream can't stall the whole pipeline.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { ...opts, headers, signal: controller.signal });
      if (res.ok) return res.json() as Promise<T>;
      // 429 (rate limit) and 5xx (server) are retryable with exponential backoff.
      // This is the fix for the 429 storms that were silently corrupting enrichment.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 1000, 8000);
        console.warn(`fetchJson: ${res.status} on ${url} (attempt ${attempt + 1}/${retries}); backing off ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        attempt++;
        continue;
      }
      throw new FetchError(res.status, await res.text());
    } catch (e) {
      if (e instanceof FetchError) throw e; // non-retryable status (or retries exhausted)
      // network error / abort / timeout — retry if attempts remain
      if (attempt < retries) {
        const wait = Math.min(2 ** attempt * 1000, 8000);
        console.warn(`fetchJson: network error on ${url} (attempt ${attempt + 1}/${retries}); retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        attempt++;
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
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

/** Gamma returns outcomes/outcomePrices as JSON strings; normalize to arrays. */
function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return []; }
  }
  return [];
}

/** Get market metadata by slug from gamma-api. Slug is the reliable filter key
 *  (gamma's condition_id filter is broken and returns a default market). */
export async function getMarketBySlug(slug: string): Promise<{
  question: string | null;
  category: string | null;
  outcomes: string[];
  outcomePrices: number[];
  clobTokenIds: string[];
  liquidity: number;
  spread: number;
  volume: number;
  endDate: string | null;
} | null> {
  const qs = new URLSearchParams({ slug, limit: "1" });
  const arr = await fetchJson<any[]>(`${GAMMA_API}/markets?${qs}`);
  const m = Array.isArray(arr) ? arr[0] : null;
  if (!m) return null;
  return {
    question: m.question ?? null,
    category: m.category ?? null,
    outcomes: parseList(m.outcomes),
    outcomePrices: parseList(m.outcomePrices).map((x) => Number(x)),
    clobTokenIds: parseList(m.clobTokenIds),
    liquidity: Number(m.liquidityNum ?? 0),
    spread: Number(m.spread ?? 0),
    volume: Number(m.volumeNum ?? 0),
    endDate: m.endDate ?? null,
  };
}

// --- Market discovery (strategy scanners) ---

/** Normalized market object from gamma-api /markets endpoint. */
export interface GammaMarket {
  id: string;
  question: string | null;
  slug: string | null;
  category: string | null;
  outcomes: string[];
  outcomePrices: number[];
  clobTokenIds: string[];
  liquidity: number;
  spread: number;
  volume24hr: number;
  volume: number;
  endDate: string | null;
  active: boolean;
  closed: boolean;
}

/** Tag object from gamma-api /tags endpoint. */
export interface GammaTag {
  id: number;
  label: string;
  slug: string;
}

/** Fetch all available tags from gamma-api. Used to resolve category → tag_id. */
export async function getTags(): Promise<GammaTag[]> {
  const arr = await fetchJson<any[]>(`${GAMMA_API}/tags`);
  if (!Array.isArray(arr)) return [];
  return arr.map((t) => ({
    id: Number(t.id),
    label: String(t.label ?? ""),
    slug: String(t.slug ?? ""),
  }));
}

export interface MarketsByTagOpts {
  limit?: number;
  offset?: number;
  liquidityMin?: number;
  endDateMin?: string; // ISO datetime
  order?: string;
  ascending?: boolean;
}

/** Fetch active markets filtered by tag_id from gamma-api. Paginated (max 100/page). */
export async function getMarketsByTag(tagId: number, opts: MarketsByTagOpts = {}): Promise<GammaMarket[]> {
  const qs = new URLSearchParams();
  qs.set("tag_id", String(tagId));
  qs.set("closed", "false");
  qs.set("limit", String(opts.limit ?? 100));
  qs.set("offset", String(opts.offset ?? 0));
  qs.set("order", opts.order ?? "volume24hr");
  qs.set("ascending", String(opts.ascending ?? false));
  if (opts.liquidityMin != null) qs.set("liquidity_num_min", String(opts.liquidityMin));
  if (opts.endDateMin) qs.set("end_date_min", opts.endDateMin);

  const arr = await fetchJson<any[]>(`${GAMMA_API}/markets?${qs}`);
  if (!Array.isArray(arr)) return [];
  return arr.map((m) => ({
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
  }));
}
