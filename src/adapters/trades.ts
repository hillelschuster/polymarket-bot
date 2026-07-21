// Adapter: wallet trade history (PUBLIC data-api/trades, no key needed). SPEC §3,§5.
import { DATA_API, fetchJson } from "./polymarket";

export interface ObservedTradeRow {
  id: string;            // transactionHash
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
}

export async function getWalletTrades(userAddress: string, opts: TradesOpts = {}): Promise<ObservedTradeRow[]> {
  const qs = new URLSearchParams({ user: userAddress });
  if (opts.limit) qs.set("limit", String(opts.limit));
  const rows = await fetchJson<any[]>(`${DATA_API}/trades?${qs}`);
  return rows.map((t) => ({
    id: t.transactionHash,
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
