// Adapter: wallet trade history (PUBLIC data-api/trades, no key needed). SPEC §3,§5.
import { createHash } from "node:crypto";
import { DATA_API, fetchJson } from "./polymarket";

export interface ObservedTradeRow {
  id: string;            // deterministic fill identity, not transaction hash alone
  transactionHash: string;
  wallet: string;        // proxyWallet
  marketId: string;      // conditionId
  conditionId: string;   // conditionId
  slug?: string;         // market slug (reliable gamma fetch key)
  tokenId: string;       // asset
  outcome?: string;
  outcomeIndex?: number; // index of the bet outcome within the market
  side?: string;
  size: number;
  price: number;
  timestamp: number;      // unix seconds
  marketQuestion?: string; // title
  [key: string]: unknown;
}

export interface TradesOpts {
  limit?: number;
  offset?: number;
}

function fillIdentity(t: any): string {
  const raw = [
    String(t.transactionHash ?? ""),
    String(t.proxyWallet ?? ""),
    String(t.conditionId ?? ""),
    String(t.asset ?? ""),
    String(t.side ?? ""),
    Number(t.price ?? 0).toFixed(8),
    Number(t.size ?? 0).toFixed(8),
    String(t.timestamp ?? ""),
    String(t.outcomeIndex ?? ""),
  ].join("|");
  return createHash("sha256").update(raw).digest("hex");
}

export async function getWalletTrades(userAddress: string, opts: TradesOpts = {}): Promise<ObservedTradeRow[]> {
  const qs = new URLSearchParams({ user: userAddress });
  if (opts.limit) qs.set("limit", String(opts.limit));
  if (opts.offset) qs.set("offset", String(opts.offset));
  const rows = await fetchJson<any[]>(`${DATA_API}/trades?${qs}`);
  return rows.map((t) => ({
    id: fillIdentity(t),
    transactionHash: String(t.transactionHash ?? ""),
    wallet: t.proxyWallet,
    marketId: t.conditionId,
    conditionId: t.conditionId,
    slug: t.slug ?? undefined,
    tokenId: t.asset,
    outcome: t.outcome ?? undefined,
    outcomeIndex: t.outcomeIndex != null ? Number(t.outcomeIndex) : undefined,
    side: t.side ?? undefined,
    size: Number(t.size),
    price: Number(t.price),
    timestamp: Number(t.timestamp),
    marketQuestion: t.title ?? undefined,
  }));
}
