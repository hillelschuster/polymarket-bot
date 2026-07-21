import type { BuyQuote, OrderBook, SellQuote } from "../adapters/polymarket.js";
import type { FeeModel } from "../adapters/marketFees.js";

export function takerFeePerShare(price: number, fee: FeeModel): number {
  if (fee.rateBps === 0) return 0;
  return (fee.rateBps / 10_000) * Math.pow(price * (1 - price), fee.exponent);
}

function edges(book: OrderBook): { bestBid: number | null; bestAsk: number | null; spread: number | null } {
  const bids = (book.bids ?? []).map((x) => Number(x.price)).filter(Number.isFinite).sort((a, b) => b - a);
  const asks = (book.asks ?? []).map((x) => Number(x.price)).filter(Number.isFinite).sort((a, b) => a - b);
  const bestBid = bids[0] ?? null;
  const bestAsk = asks[0] ?? null;
  return { bestBid, bestAsk, spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null };
}

function minimumOrderPasses(book: OrderBook, shares: number): boolean {
  const min = Number(book.min_order_size ?? 0);
  return !Number.isFinite(min) || min <= 0 || shares >= min;
}

export function quoteBuySharesExact(book: OrderBook, feeModel: FeeModel, shares: number): BuyQuote | null {
  if (!(shares > 0) || !minimumOrderPasses(book, shares)) return null;
  const asks = [...(book.asks ?? [])]
    .map((x) => ({ price: Number(x.price), size: Number(x.size) }))
    .filter((x) => Number.isFinite(x.price) && Number.isFinite(x.size) && x.price > 0 && x.price < 1 && x.size > 0)
    .sort((a, b) => a.price - b.price);

  let remaining = shares;
  let notional = 0;
  let fee = 0;
  for (const level of asks) {
    const take = Math.min(level.size, remaining);
    notional += take * level.price;
    fee += take * takerFeePerShare(level.price, feeModel);
    remaining -= take;
    if (remaining <= 1e-8) break;
  }
  if (remaining > 1e-6) return null;
  const top = edges(book);
  if (top.bestAsk == null) return null;
  const cashCost = notional + fee;
  return {
    shares,
    cashCost,
    averageAsk: notional / shares,
    fee,
    allInPrice: cashCost / shares,
    bestBid: top.bestBid,
    bestAsk: top.bestAsk,
    spread: top.spread,
  };
}

export function quoteSellSharesExact(book: OrderBook, feeModel: FeeModel, shares: number): SellQuote | null {
  if (!(shares > 0) || !minimumOrderPasses(book, shares)) return null;
  const bids = [...(book.bids ?? [])]
    .map((x) => ({ price: Number(x.price), size: Number(x.size) }))
    .filter((x) => Number.isFinite(x.price) && Number.isFinite(x.size) && x.price > 0 && x.price < 1 && x.size > 0)
    .sort((a, b) => b.price - a.price);

  let remaining = shares;
  let notional = 0;
  let fee = 0;
  for (const level of bids) {
    const take = Math.min(level.size, remaining);
    notional += take * level.price;
    fee += take * takerFeePerShare(level.price, feeModel);
    remaining -= take;
    if (remaining <= 1e-8) break;
  }
  if (remaining > 1e-6) return null;
  const top = edges(book);
  if (top.bestBid == null) return null;
  const cashProceeds = notional - fee;
  return {
    shares,
    cashProceeds,
    averageBid: notional / shares,
    fee,
    netPrice: cashProceeds / shares,
    bestBid: top.bestBid,
    bestAsk: top.bestAsk,
    spread: top.spread,
  };
}
