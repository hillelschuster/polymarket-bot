// Job: paper:update-pnl. Hourly PnL snapshots from live market prices. SPEC §10.
import { prisma } from "../lib/db.js";
import { hourlyPnl, closePaperTrade } from "../lib/paper.js";
import { getMarketBySlug } from "../adapters/polymarket.js";
import { DEFAULT_RULES } from "../lib/scoring.js";

export async function runPaperUpdatePnl(): Promise<void> {
  const activeRs = await prisma.ruleSet.findFirst({ where: { active: true }, orderBy: { version: "desc" } });
  const rules = activeRs ? (JSON.parse(activeRs.rulesJson) as typeof DEFAULT_RULES) : DEFAULT_RULES;

  const open = await prisma.paperTrade.findMany({
    where: { status: "open" },
    include: { decisionJournal: { include: { observedTrade: true } } },
  });
  if (!open.length) {
    console.log("paperUpdatePnl: no open trades");
    return;
  }

  // Dedupe by slug so we hit gamma once per market, not per trade.
  const bySlug = new Map<string, typeof open>();
  for (const pt of open) {
    const slug = pt.slug;
    if (!slug) continue;
    const arr = bySlug.get(slug) ?? [];
    arr.push(pt);
    bySlug.set(slug, arr);
  }

  const mktBySlug = new Map<string, Awaited<ReturnType<typeof getMarketBySlug>>>();
  for (const [slug] of bySlug) {
    try {
      mktBySlug.set(slug, await getMarketBySlug(slug));
    } catch {
      /* skip */
    }
    await new Promise((r) => setTimeout(r, 120)); // respect gamma rate limit
  }

  const priceOf = (slug: string | null, tokenId: string | null): number | null => {
    if (!slug) return null;
    const m = mktBySlug.get(slug);
    if (!m || !tokenId) return null;
    const idx = m.clobTokenIds.indexOf(String(tokenId));
    if (idx < 0 || !(idx in m.outcomePrices)) return null;
    return m.outcomePrices[idx];
  };

  let n = 0;
  for (const pt of open) {
    const currentPrice = priceOf(pt.slug, pt.tokenId) ?? pt.currentPrice ?? pt.entryPrice ?? 0.5;
    const updated = hourlyPnl(
      {
        walletAddress: pt.walletAddress,
        marketId: pt.marketId,
        outcome: pt.outcome ?? "YES",
        side: pt.side ?? "BUY",
        entryPrice: pt.entryPrice ?? 0.5,
        simulatedPositionSize: pt.simulatedPositionSize ?? 10,
        status: "open",
        currentPrice: pt.currentPrice ?? pt.entryPrice ?? 0.5,
        unrealizedPnl: pt.unrealizedPnl ?? 0,
        realizedPnl: null,
        openedAt: pt.openedAt.getTime(),
        closedAt: null,
        resolvedAt: null,
      },
      currentPrice,
    );
    // Stop-loss: close open trades whose unrealized loss exceeds stopLossPct of size.
    const lossFrac = updated.unrealizedPnl / (pt.simulatedPositionSize ?? 10);
    if (lossFrac < -rules.stopLossPct) {
      const closed = closePaperTrade(
        {
          walletAddress: pt.walletAddress,
          marketId: pt.marketId,
          outcome: pt.outcome ?? "YES",
          side: pt.side ?? "BUY",
          entryPrice: pt.entryPrice ?? 0.5,
          simulatedPositionSize: pt.simulatedPositionSize ?? 10,
          status: "open",
          currentPrice: pt.currentPrice ?? pt.entryPrice ?? 0.5,
          unrealizedPnl: pt.unrealizedPnl ?? 0,
          realizedPnl: null,
          openedAt: pt.openedAt.getTime(),
          closedAt: null,
          resolvedAt: null,
        },
        currentPrice,
      );
      await prisma.paperTrade.update({
        where: { id: pt.id },
        data: {
          currentPrice: closed.currentPrice,
          unrealizedPnl: 0,
          realizedPnl: closed.realizedPnl,
          status: "closed",
          closedAt: new Date(closed.closedAt!),
        },
      });
      await prisma.pnlSnapshot.create({
        data: { paperTradeId: pt.id, price: currentPrice, pnl: closed.realizedPnl ?? updated.unrealizedPnl },
      });
      n++;
      continue;
    }

    await prisma.paperTrade.update({
      where: { id: pt.id },
      data: { currentPrice: updated.currentPrice, unrealizedPnl: updated.unrealizedPnl },
    });
    await prisma.pnlSnapshot.create({
      data: { paperTradeId: pt.id, price: currentPrice, pnl: updated.unrealizedPnl },
    });
    n++;
  }
  console.log(`paperUpdatePnl done: ${n} snapshots`);
}

if (require.main === module) runPaperUpdatePnl().catch(console.error);
