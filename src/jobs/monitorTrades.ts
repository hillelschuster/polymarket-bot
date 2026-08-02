// Job: monitor:trades. Poll trades per tracked wallet -> ObservedTrade. SPEC §10.
import { prisma } from "../lib/db.js";
import { isLive } from "../lib/config.js";
import { getWalletTrades } from "../adapters/trades.js";
import { getMarketBySlug } from "../adapters/polymarket.js";

export function trackedWalletWhere(): { status: "track" } {
  return { status: "track" };
}

export async function runMonitorTrades(): Promise<void> {
  if (!isLive) {
    console.log("DEMO mode: skipping live trade monitor");
    return;
  }
  const tracked = await prisma.walletProfile.findMany({ where: trackedWalletWhere() });
  if (!tracked.length) {
    console.log("monitorTrades: no tracked wallets found");
    return;
  }
  let total = 0;
  const mktCache = new Map<string, Awaited<ReturnType<typeof getMarketBySlug>>>();
  for (const w of tracked) {
    const trades = await getWalletTrades(w.address, { limit: 20 });
    await new Promise((r) => setTimeout(r, 200)); // pace data-api calls (avoid 429)
    for (const t of trades) {
      const slug = t.slug;
      let mkt = slug ? mktCache.get(slug) : undefined;
      if (mkt === undefined && slug) {
        mkt = await getMarketBySlug(slug);
        mktCache.set(slug, mkt);
      }
      await prisma.observedTrade.upsert({
        where: { id: t.id },
        create: {
          id: t.id,
          walletAddress: w.address,
          marketId: t.marketId,
          conditionId: t.conditionId,
          slug: slug ?? null,
          tokenId: t.tokenId,
          marketQuestion: t.marketQuestion ?? null,
          marketCategory: mkt?.category ?? null,
          marketLiquidity: mkt?.liquidity ?? null,
          marketSpread: mkt?.spread ?? null,
          outcome: t.outcome ?? null,
          outcomeIndex: t.outcomeIndex ?? null,
          side: t.side ?? null,
          detectedPrice: t.price,
          size: t.size,
          timestamp: new Date(t.timestamp * 1000),
          rawTradeJson: JSON.stringify(t),
        },
        update: {}, // already recorded
      });
      total++;
    }
  }
  console.log(`monitorTrades done: ${total} trades from ${tracked.length} wallets`);
}

if (require.main === module) runMonitorTrades().catch(console.error);
