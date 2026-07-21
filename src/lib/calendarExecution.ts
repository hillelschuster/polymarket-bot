import type { BuyQuote, OrderBook } from "../adapters/polymarket.js";
import type { FeeModel } from "../adapters/marketFees.js";
import { quoteBuySharesExact } from "./executableQuotes.js";
import { worstAskForShares } from "./realtimeOrderBook.js";

export interface CalendarBasketQuote {
  shares: number;
  early: BuyQuote;
  late: BuyQuote;
  earlyLimitPrice: number;
  lateLimitPrice: number;
  combinedCost: number;
  cashCost: number;
  guaranteedProfit: number;
}

export interface CalendarBasketQuoteArgs {
  earlyBook: OrderBook;
  lateBook: OrderBook;
  earlyFee: FeeModel;
  lateFee: FeeModel;
  basketCash: number;
  maxCombinedCost: number;
  maxLegSpread: number;
  minProfit: number;
}

export function quoteCalendarBasket(args: CalendarBasketQuoteArgs): CalendarBasketQuote | null {
  if (!(args.basketCash > 0) || !(args.maxCombinedCost > 0 && args.maxCombinedCost < 1)) return null;

  // Equal shares guarantee a payout of at least $1 per pair.
  const shares = args.basketCash / args.maxCombinedCost;
  const early = quoteBuySharesExact(args.earlyBook, args.earlyFee, shares);
  const late = quoteBuySharesExact(args.lateBook, args.lateFee, shares);
  if (!early || !late || early.spread == null || late.spread == null) return null;
  if (early.spread > args.maxLegSpread || late.spread > args.maxLegSpread) return null;

  const combinedCost = early.allInPrice + late.allInPrice;
  if (combinedCost > args.maxCombinedCost) return null;
  const earlyLimitPrice = worstAskForShares(args.earlyBook, shares);
  const lateLimitPrice = worstAskForShares(args.lateBook, shares);
  if (earlyLimitPrice == null || lateLimitPrice == null) return null;

  const cashCost = early.cashCost + late.cashCost;
  const guaranteedProfit = shares - cashCost;
  if (cashCost > args.basketCash + 0.01 || guaranteedProfit < args.minProfit) return null;

  return { shares, early, late, earlyLimitPrice, lateLimitPrice, combinedCost, cashCost, guaranteedProfit };
}
