// Adapter: Polymarket trader leaderboard (data-api, public). See SPEC §3,§5.
import { DATA_API, fetchJson } from "./polymarket";

export type LeaderboardCategory =
  | "OVERALL"
  | "POLITICS"
  | "SPORTS"
  | "CRYPTO"
  | "CULTURE"
  | "MENTIONS"
  | "WEATHER"
  | "ECONOMICS"
  | "TECH"
  | "FINANCE";

export interface LeaderboardRow {
  id: string;
  rank: number;
  userName: string;
  avatar: string;
  totalPnl: number;
  volume: number;
  roi: number;
  [key: string]: unknown;
}

export interface LeaderboardParams {
  category?: LeaderboardCategory;
  timePeriod?: "DAY" | "WEEK" | "MONTH" | "ALL";
  orderBy?: "PNL" | "VOL";
  limit?: number;
  offset?: number;
}

export async function getLeaderboard(params: LeaderboardParams = {}): Promise<LeaderboardRow[]> {
  const qs = new URLSearchParams();
  if (params.category) qs.set("category", params.category);
  // Current Data API uses camelCase query names. Snake-case silently falls back to defaults.
  if (params.timePeriod) qs.set("timePeriod", params.timePeriod);
  if (params.orderBy) qs.set("orderBy", params.orderBy);
  if (params.limit) qs.set("limit", String(Math.min(params.limit, 50)));
  if (params.offset) qs.set("offset", String(Math.min(params.offset, 1000)));
  const raw = await fetchJson<any[]>(`${DATA_API}/v1/leaderboard?${qs}`);
  // Real API fields: proxyWallet (address), rank (string), pnl, vol.
  // `pnl / vol` is turnover efficiency, not true return on capital; retain only as a proxy.
  return raw.map((r) => ({
    id: r.proxyWallet,
    rank: Number(r.rank) || 0,
    userName: String(r.userName ?? "").replace(/-\d+$/, ""),
    avatar: "",
    totalPnl: Number(r.pnl ?? 0),
    volume: Number(r.vol ?? 0),
    roi: r.vol > 0 ? Number(r.pnl) / Number(r.vol) : 0,
  }));
}

export async function paginateLeaderboard(
  total = 500,
  params: Omit<LeaderboardParams, "limit" | "offset"> = {},
): Promise<LeaderboardRow[]> {
  const limit = Math.min(total, 1000);
  const rows: LeaderboardRow[] = [];
  for (let offset = 0; offset < limit; offset += 50) {
    const page = await getLeaderboard({ ...params, limit: 50, offset });
    rows.push(...page);
    if (page.length < 50) break;
    if (offset + 50 < limit) await new Promise((r) => setTimeout(r, 250));
  }
  return rows;
}
