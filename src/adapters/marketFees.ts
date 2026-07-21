import { CLOB_API, fetchJson } from "./polymarket.js";

export interface FeeModel {
  rateBps: number;
  exponent: number;
}

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { value: FeeModel; expiresAt: number }>();

export async function getFeeModel(tokenId: string, conditionId: string): Promise<FeeModel> {
  const cached = cache.get(tokenId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (!conditionId) throw new Error(`Missing condition ID for token ${tokenId}`);

  const [fee, market] = await Promise.all([
    fetchJson<{ base_fee: number | string }>(
      `${CLOB_API}/fee-rate?${new URLSearchParams({ token_id: tokenId })}`,
    ),
    fetchJson<{ fd?: { e?: number | string } }>(
      `${CLOB_API}/clob-markets/${encodeURIComponent(conditionId)}`,
    ),
  ]);

  const rateBps = Number(fee.base_fee);
  const rawExponent = market.fd?.e;
  const exponent = rawExponent == null ? (rateBps === 0 ? 0 : Number.NaN) : Number(rawExponent);
  if (!Number.isFinite(rateBps) || rateBps < 0) throw new Error(`Invalid fee rate for ${tokenId}`);
  if (!Number.isFinite(exponent) || exponent < 0) throw new Error(`Invalid fee exponent for ${tokenId}`);

  const value = { rateBps, exponent };
  cache.set(tokenId, { value, expiresAt: Date.now() + CACHE_MS });
  return value;
}
