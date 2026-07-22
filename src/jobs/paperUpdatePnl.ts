// Mark open paper trades to executable CLOB exit prices, not Gamma midpoints.
import { prisma } from "../lib/db.js";
import { hourlyPnl, closePaperTrade } from "../lib/paper.js";
import { getExecutableSellQuote } from "../adapters/polymarket.js";
import { DEFAULT_RULES } from "../lib/scoring.js";
import { walletCopyCategory } from "../lib/walletCopyCategory.js";

export async function runPaperUpdatePnl(): Promise<void> {
  const activeRs = await prisma.ruleSet.findFirst({ where: { active: true }, orderBy: { version: "desc" } });
  const rules = activeRs ? ({ ...DEFAULT_RULES, ...JSON.parse(activeRs.rulesJson) } as typeof DEFAULT_RULES) : DEFAULT_RULES;
  const open = await prisma.paperTrade.findMany({ where: { status: "open" } });
  if (!open.length) {
    console.log("paperUpdatePnl: no open trades");
    return;
  }

  let updatedCount = 0;
  let skipped = 0;
  for (const pt of open) {
    const entryPrice = pt.entryPrice ?? 0;
    const cashInvested = pt.simulatedPositionSize ?? 0;
    if (!pt.tokenId || entryPrice <= 0 || cashInvested <= 0) {
      skipped++;
      continue;
    }

    const shares = cashInvested / entryPrice;
    let quote;
    try {
      quote = await getExecutableSellQuote(pt.tokenId, shares);
    } catch {
      skipped++;
      continue;
    }
    if (!quote) {
      skipped++;
      continue;
    }

    const trade = {
      walletAddress: pt.walletAddress,
      marketId: pt.marketId,
      outcome: pt.outcome ?? "YES",
      side: pt.side ?? "BUY",
      entryPrice,
      simulatedPositionSize: cashInvested,
      status: "open" as const,
      currentPrice: pt.currentPrice ?? entryPrice,
      unrealizedPnl: pt.unrealizedPnl ?? 0,
      realizedPnl: null,
      openedAt: pt.openedAt.getTime(),
      closedAt: null,
      resolvedAt: null,
    };
    const updated = hourlyPnl(trade, quote.netPrice);
    const lossFrac = updated.unrealizedPnl / cashInvested;

    const isCalendarBasket = pt.walletAddress.startsWith("STRATEGY:calendar_arb:");
    const isSportsWalletCopy = pt.source === "wallet_copy" && walletCopyCategory(pt.slug) === "sports";
    const useGenericStop = !isCalendarBasket && !isSportsWalletCopy;
    if (useGenericStop && lossFrac < -rules.stopLossPct) {
      const closed = closePaperTrade(trade, quote.netPrice);
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
        data: { paperTradeId: pt.id, price: quote.netPrice, pnl: closed.realizedPnl },
      });
      updatedCount++;
      continue;
    }

    await prisma.paperTrade.update({
      where: { id: pt.id },
      data: { currentPrice: quote.netPrice, unrealizedPnl: updated.unrealizedPnl },
    });
    await prisma.pnlSnapshot.create({
      data: { paperTradeId: pt.id, price: quote.netPrice, pnl: updated.unrealizedPnl },
    });
    updatedCount++;
  }

  console.log(`paperUpdatePnl done: ${updatedCount} executable marks, ${skipped} skipped`);
}

if (require.main === module) runPaperUpdatePnl().catch(console.error);
