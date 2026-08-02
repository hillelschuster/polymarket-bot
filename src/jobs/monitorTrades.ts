// Job: monitor:trades. Poll trades per tracked wallet -> ObservedTrade. SPEC §10.
import { prisma } from "../lib/db.js";
import { isLive } from "../lib/config.js";
import { getWalletTrades } from "../adapters/trades.js";
import { getMarketBySlug } from "../adapters/polymarket.js";

export function trackedWalletWhere(): { status: "track" } {
  return { status: "track" };
}

// Bounded worker pool: a few concurrent wallet polls with globally paced starts.
// The old sequential sweep (1 wallet at a time + 200ms after each) took 11–17 min
// for ~420 wallets, pushing the cycle past the 20-min sports signal window.
const POOL_CONCURRENCY = 3;
const WALLET_START_GAP_MS = 250;

export async function runMonitorTrades(): Promise<void> {
  if (!isLive) {
    console.log("DEMO mode: skipping live trade monitor");
    return;
  }
  const t0 = Date.now();
  const tracked = await prisma.walletProfile.findMany({ where: trackedWalletWhere() });
  if (!tracked.length) {
    console.log("monitorTrades: no tracked wallets found");
    return;
  }

  let total = 0;
  let failed = 0;

  // Shared market lookup. Caching the in-flight Promise (not just the resolved
  // value) guarantees two workers never fetch the same slug simultaneously.
  const mktCache = new Map<string, Promise<Awaited<ReturnType<typeof getMarketBySlug>>>>();
  const marketFor = (slug: string) => {
    let p = mktCache.get(slug);
    if (!p) {
      p = getMarketBySlug(slug).catch((e) => {
        mktCache.delete(slug); // don't pin the failure; allow a later retry
        throw e;
      });
      mktCache.set(slug, p);
    }
    return p;
  };

  // Global start pacer: reserve a slot synchronously (atomic in single-threaded
  // JS), then wait for it. Keeps data-api request starts ~250ms apart overall.
  let nextStartAt = Date.now();
  const pacedStart = async () => {
    const slot = nextStartAt;
    nextStartAt += WALLET_START_GAP_MS;
    const wait = slot - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };

  const pollWallet = async (address: string) => {
    const trades = await getWalletTrades(address, { limit: 20 });
    for (const t of trades) {
      const slug = t.slug;
      const mkt = slug ? await marketFor(slug) : null;
      await prisma.observedTrade.upsert({
        where: { id: t.id },
        create: {
          id: t.id,
          walletAddress: address,
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
  };

  let next = 0;
  const worker = async () => {
    while (next < tracked.length) {
      const w = tracked[next++];
      await pacedStart();
      try {
        await pollWallet(w.address);
      } catch (e) {
        // One bad wallet (network/429-exhaustion/market lookup) must not kill the pass.
        failed++;
        console.error(`monitorTrades: wallet ${w.address.slice(0, 10)} failed: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: POOL_CONCURRENCY }, () => worker()));

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`monitorTrades done: ${total} trades from ${tracked.length} wallets in ${secs}s (${failed} wallet failures)`);
}

if (require.main === module) runMonitorTrades().catch(console.error);
