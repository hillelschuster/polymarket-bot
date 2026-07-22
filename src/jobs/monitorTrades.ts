// Job: monitor:trades. Capture complete fresh wallet fills with bounded concurrency.
import { prisma } from "../lib/db.js";
import { isLive } from "../lib/config.js";
import { getWalletTrades, type ObservedTradeRow } from "../adapters/trades.js";
import { getMarketBySlug } from "../adapters/polymarket.js";

const PAGE_SIZE = 100;
const MAX_PAGES_PER_WALLET = 5;
const WALLET_CONCURRENCY = 5;
const WATCH_WALLETS_PER_HOURLY_PASS = 20;

function fillSignature(input: {
  tokenId?: string | null; side?: string | null; price?: number | null; detectedPrice?: number | null;
  size?: number | null; timestamp?: number | Date | null;
}): string {
  const timestamp = input.timestamp instanceof Date
    ? Math.floor(input.timestamp.getTime() / 1000)
    : Number(input.timestamp ?? 0);
  return [
    input.tokenId ?? "",
    (input.side ?? "").toUpperCase(),
    Number(input.price ?? input.detectedPrice ?? 0).toFixed(8),
    Number(input.size ?? 0).toFixed(8),
    String(timestamp),
  ].join("|");
}

async function mapConcurrent<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
}

export async function runMonitorTrades(): Promise<void> {
  if (!isLive) {
    console.log("DEMO mode: skipping live trade monitor");
    return;
  }

  const profiles = await prisma.walletProfile.findMany({
    where: { status: { in: ["track", "watch"] } },
    orderBy: [{ status: "asc" }, { globalScore: "desc" }, { sourceRank: "asc" }],
  });
  const track = profiles.filter((wallet) => wallet.status === "track");
  // The main loop normally runs every 15 minutes. Watch-list exploration runs once per
  // four slots so uncertain wallets remain observable without slowing the core signal path.
  const scanWatch = Math.floor(Date.now() / (15 * 60 * 1000)) % 4 === 0;
  const watch = scanWatch
    ? profiles.filter((wallet) => wallet.status === "watch").slice(0, WATCH_WALLETS_PER_HOURLY_PASS)
    : [];
  const eligible = [...track, ...watch];

  if (!eligible.length) {
    console.log("monitorTrades: no eligible wallets found");
    return;
  }

  const marketPromises = new Map<string, ReturnType<typeof getMarketBySlug>>();
  const marketFor = (slug: string) => {
    let promise = marketPromises.get(slug);
    if (!promise) {
      promise = getMarketBySlug(slug).catch(() => null);
      marketPromises.set(slug, promise);
    }
    return promise;
  };

  let fetched = 0;
  let stored = 0;
  let failedWallets = 0;

  await mapConcurrent(eligible, WALLET_CONCURRENCY, async (wallet) => {
    try {
      const latest = await prisma.observedTrade.findFirst({
        where: { walletAddress: wallet.address },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      });
      const watermarkSec = latest?.timestamp ? Math.floor(latest.timestamp.getTime() / 1000) : 0;
      const fresh = new Map<string, ObservedTradeRow>();

      for (let page = 0; page < MAX_PAGES_PER_WALLET; page++) {
        const rows = await getWalletTrades(wallet.address, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
        fetched += rows.length;
        for (const trade of rows) fresh.set(trade.id, trade);
        if (rows.length < PAGE_SIZE) break;
        const oldest = Math.min(...rows.map((trade) => trade.timestamp));
        // Fetch the page containing the watermark so same-second fills are still captured.
        if (watermarkSec > 0 && oldest < watermarkSec) break;
      }

      const ordered = [...fresh.values()].sort((a, b) => a.timestamp - b.timestamp);
      const earliest = ordered[0]?.timestamp;
      const existingRows = earliest != null
        ? await prisma.observedTrade.findMany({
            where: { walletAddress: wallet.address, timestamp: { gte: new Date(earliest * 1000) } },
            select: { id: true, tokenId: true, side: true, detectedPrice: true, size: true, timestamp: true },
          })
        : [];
      const existingSignatures = new Set(existingRows.map((row) => fillSignature(row)));

      for (const trade of ordered) {
        // One-time compatibility with the former transaction-hash IDs: do not replay an
        // already-recorded fill merely because its improved deterministic ID is different.
        const signature = fillSignature(trade);
        if (existingSignatures.has(signature) && !existingRows.some((row) => row.id === trade.id)) continue;
        const slug = trade.slug;
        const market = slug ? await marketFor(slug) : null;
        await prisma.observedTrade.upsert({
          where: { id: trade.id },
          create: {
            id: trade.id,
            walletAddress: wallet.address,
            marketId: trade.marketId,
            conditionId: trade.conditionId,
            slug: slug ?? null,
            tokenId: trade.tokenId,
            marketQuestion: trade.marketQuestion ?? null,
            marketCategory: market?.category ?? null,
            marketLiquidity: market?.liquidity ?? null,
            marketSpread: market?.spread ?? null,
            outcome: trade.outcome ?? null,
            outcomeIndex: trade.outcomeIndex ?? null,
            side: trade.side ?? null,
            walletEntryPrice: trade.price,
            detectedPrice: trade.price,
            size: trade.size,
            timestamp: new Date(trade.timestamp * 1000),
            rawTradeJson: JSON.stringify(trade),
          },
          update: {},
        });
        stored++;
        existingSignatures.add(signature);
      }
    } catch (error) {
      failedWallets++;
      console.error(`monitorTrades: ${wallet.address} failed:`, error instanceof Error ? error.message : error);
    }
  });

  console.log(
    `monitorTrades done: ${stored} fills processed (${fetched} fetched) from ${eligible.length} wallets `
    + `(${track.length} core${scanWatch ? ` + ${watch.length} exploratory` : ""}), ${failedWallets} wallet failures`,
  );
}

if (require.main === module) runMonitorTrades().catch(console.error);
