import {
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
  type CreateOrderOptions,
  type OrderBookSummary,
  type OrderResponse,
  type TickSize,
  type Trade,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { assertLiveTradingConfigured, config } from "../lib/config.js";
import type { FeeModel } from "./marketFees.js";
import type { BuyQuote, OrderBook } from "./polymarket.js";
import { quoteBuySharesExact, quoteSellSharesExact } from "../lib/executableQuotes.js";
import { worstAskForShares, worstBidForShares } from "../lib/realtimeOrderBook.js";

export type LegSettlement = "confirmed" | "matched" | "pending" | "failed" | "unknown";

export interface ExactBuyLeg {
  tokenId: string;
  shares: number;
  limitPrice: number;
  estimatedCashCost: number;
  tickSize?: string;
  negRisk?: boolean;
}

export interface PreparedFokBuy {
  leg: ExactBuyLeg;
  quote: BuyQuote;
}

export interface UnwindResult {
  success: boolean;
  orderId?: string;
  response?: OrderResponse;
  estimatedPnl?: number;
  error?: string;
}

export interface BasketExecutionResult {
  status: "matched_pending" | "not_filled" | "unwound" | "unwind_failed" | "manual_review";
  earlyResponse?: OrderResponse;
  lateResponse?: OrderResponse;
  earlyState: LegSettlement;
  lateState: LegSettlement;
  unwind?: UnwindResult;
  error?: string;
}

let client: ClobClient | null = null;

function asOrderResponse(value: unknown): OrderResponse {
  const raw = (value ?? {}) as Partial<OrderResponse> & { error?: string };
  return {
    success: raw.success === true,
    errorMsg: String(raw.errorMsg ?? raw.error ?? ""),
    orderID: String(raw.orderID ?? ""),
    transactionsHashes: Array.isArray(raw.transactionsHashes) ? raw.transactionsHashes.map(String) : [],
    tradeIDs: Array.isArray(raw.tradeIDs) ? raw.tradeIDs.map(String) : [],
    status: String(raw.status ?? ""),
    takingAmount: String(raw.takingAmount ?? ""),
    makingAmount: String(raw.makingAmount ?? ""),
  };
}

export function getTradingClient(): ClobClient {
  assertLiveTradingConfigured();
  if (client) return client;

  const account = privateKeyToAccount(config.POLYMARKET_PRIVATE_KEY as Hex);
  const signer = createWalletClient({
    account,
    chain: polygon,
    transport: http(config.POLYGON_RPC_URL || undefined),
  });
  const creds: ApiKeyCreds = {
    key: config.CLOB_API_KEY!,
    secret: config.CLOB_API_SECRET!,
    passphrase: config.CLOB_API_PASSPHRASE!,
  };
  client = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: Chain.POLYGON,
    signer,
    creds,
    signatureType: config.POLYMARKET_SIGNATURE_TYPE as SignatureTypeV2,
    funderAddress: config.POLYMARKET_FUNDER_ADDRESS || undefined,
    builderConfig: config.POLYMARKET_BUILDER_CODE
      ? { builderCode: config.POLYMARKET_BUILDER_CODE }
      : undefined,
    useServerTime: true,
    retryOnError: false,
    throwOnError: false,
  });
  return client;
}

function immediateState(response: OrderResponse): LegSettlement {
  if (!response.success) return "failed";
  if ((response.transactionsHashes?.length ?? 0) > 0) return "confirmed";
  if ((response.tradeIDs?.length ?? 0) > 0) return "matched";
  const status = response.status.toLowerCase();
  if (status === "matched") return "matched";
  if (["cancelled", "canceled", "failed", "rejected"].includes(status)) return "failed";
  if (["delayed", "unmatched", "live", "pending"].includes(status)) return "pending";
  return response.errorMsg ? "failed" : "unknown";
}

async function tradesFor(response: OrderResponse): Promise<Trade[]> {
  if (!response.tradeIDs?.length) return [];
  const trading = getTradingClient();
  const pages = await Promise.all(
    response.tradeIDs.map((id) => trading.getTrades({ id }, true).catch(() => [] as Trade[])),
  );
  return pages.flat();
}

export async function inspectOrderResponse(response: OrderResponse): Promise<LegSettlement> {
  const immediate = immediateState(response);
  if (immediate === "failed" || immediate === "confirmed") return immediate;

  const trades = await tradesFor(response);
  if (trades.some((trade) => trade.status.toUpperCase() === "FAILED")) return "failed";
  if (trades.length && trades.every((trade) => trade.status.toUpperCase() === "CONFIRMED" || Boolean(trade.transaction_hash))) {
    return "confirmed";
  }
  if (trades.some((trade) => ["MATCHED", "MINED", "RETRYING"].includes(trade.status.toUpperCase()))) {
    return "matched";
  }

  if (response.orderID) {
    try {
      const order = await getTradingClient().getOrder(response.orderID);
      const original = Number(order.original_size ?? 0);
      const matched = Number(order.size_matched ?? 0);
      const status = String(order.status ?? "").toLowerCase();
      if (original > 0 && matched >= original - 1e-8) return "matched";
      if (["cancelled", "canceled", "failed", "rejected"].includes(status)) return "failed";
      if (status) return "pending";
    } catch {
      // The order endpoint can lag the placement response.
    }
  }
  return immediate;
}

async function settleQuick(response: OrderResponse, maxMs = 700): Promise<LegSettlement> {
  let state = immediateState(response);
  if (state === "failed" || state === "confirmed" || state === "matched") return state;
  const deadline = Date.now() + maxMs;
  do {
    state = await inspectOrderResponse(response);
    if (state === "failed" || state === "confirmed" || state === "matched") return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return state;
}

function held(state: LegSettlement): boolean {
  return state === "matched" || state === "confirmed";
}

const TICKS = new Set(["0.1", "0.01", "0.005", "0.0025", "0.001", "0.0001"]);
function orderOptions(tickSize?: string, negRisk?: boolean): Partial<CreateOrderOptions> | undefined {
  const options: Partial<CreateOrderOptions> = {};
  if (tickSize && TICKS.has(tickSize)) options.tickSize = tickSize as TickSize;
  if (negRisk != null) options.negRisk = negRisk;
  return Object.keys(options).length ? options : undefined;
}

/**
 * Re-quote an already-approved wallet-copy size on the authenticated CLOB.
 * The live order may only proceed at the original all-in price and cash budget
 * or better. The FOK limit is the actual worst raw ask, never a fee-inclusive
 * synthetic price.
 */
export function prepareFokBuyOrder(input: {
  tokenId: string;
  book: OrderBook;
  fee: FeeModel;
  shares: number;
  maxCashCost: number;
  maxAllInPrice: number;
}): PreparedFokBuy | null {
  if (!TICKS.has(String(input.book.tick_size))) return null;
  const roundedShares = Number(input.shares.toFixed(2));
  if (roundedShares <= 0) return null;
  const quote = quoteBuySharesExact(input.book, input.fee, roundedShares);
  const limitPrice = worstAskForShares(input.book, roundedShares);
  if (!quote || limitPrice == null) return null;
  if (quote.cashCost > input.maxCashCost + 0.005) return null;
  if (quote.allInPrice > input.maxAllInPrice + 1e-8) return null;

  return {
    quote,
    leg: {
      tokenId: input.tokenId,
      shares: roundedShares,
      limitPrice,
      estimatedCashCost: Number(quote.cashCost.toFixed(2)),
      tickSize: input.book.tick_size,
      negRisk: input.book.neg_risk,
    },
  };
}

function toBook(raw: OrderBookSummary): OrderBook {
  return {
    market: raw.market,
    asset_id: raw.asset_id,
    bids: raw.bids,
    asks: raw.asks,
    min_order_size: raw.min_order_size,
    tick_size: raw.tick_size,
    neg_risk: raw.neg_risk,
    timestamp: raw.timestamp,
    last_trade_price: raw.last_trade_price,
  };
}

async function liveFeeModel(trading: ClobClient, tokenId: string): Promise<FeeModel> {
  const [rateBps, exponent] = await Promise.all([
    trading.getFeeRateBps(tokenId),
    trading.getFeeExponent(tokenId),
  ]);
  return { rateBps, exponent };
}

export interface FokBuyResult {
  status: "filled" | "not_filled" | "unknown";
  state?: LegSettlement;
  response?: OrderResponse;
  prepared?: PreparedFokBuy;
  error?: string;
}

/** One exact-share FOK buy. Any ambiguous result is fail-closed as unknown. */
export async function executeFokBuy(input: {
  tokenId: string;
  shares: number;
  maxCashCost: number;
  maxAllInPrice: number;
}): Promise<FokBuyResult> {
  try {
    const trading = getTradingClient();
    const [rawBook, fee] = await Promise.all([
      trading.getOrderBook(input.tokenId),
      liveFeeModel(trading, input.tokenId),
    ]);
    const prepared = prepareFokBuyOrder({
      tokenId: input.tokenId,
      book: toBook(rawBook),
      fee,
      shares: input.shares,
      maxCashCost: input.maxCashCost,
      maxAllInPrice: input.maxAllInPrice,
    });
    if (!prepared) return { status: "not_filled", error: "fresh CLOB quote exceeds approved limits" };

    const signed = await trading.createOrder(
      {
        tokenID: prepared.leg.tokenId,
        price: prepared.leg.limitPrice,
        size: prepared.leg.shares,
        side: Side.BUY,
      },
      orderOptions(prepared.leg.tickSize, prepared.leg.negRisk),
    );
    const response = asOrderResponse(await trading.postOrder(signed, OrderType.FOK, false, true));
    const state = await settleQuick(response, 1_500);
    if (held(state)) return { status: "filled", state, response, prepared };
    if (state === "failed") return { status: "not_filled", state, response, prepared };
    return { status: "unknown", state, response, prepared, error: `FOK order state ${state}` };
  } catch (error) {
    return {
      status: "unknown",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function unwindExactShares(leg: ExactBuyLeg, attempts = 20): Promise<UnwindResult> {
  const trading = getTradingClient();
  let lastError = "no executable bid";

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const [rawBook, fee] = await Promise.all([
        trading.getOrderBook(leg.tokenId),
        liveFeeModel(trading, leg.tokenId),
      ]);
      const book = toBook(rawBook);
      const quote = quoteSellSharesExact(book, fee, leg.shares);
      const limitPrice = worstBidForShares(book, leg.shares);
      if (!quote || limitPrice == null) {
        lastError = "insufficient unwind depth";
      } else {
        const signed = await trading.createOrder(
          { tokenID: leg.tokenId, price: limitPrice, size: leg.shares, side: Side.SELL },
          orderOptions(book.tick_size, book.neg_risk),
        );
        const response = asOrderResponse(await trading.postOrder(signed, OrderType.FOK, false, true));
        const state = await settleQuick(response, 1_500);
        if (held(state)) {
          return {
            success: true,
            orderId: response.orderID || undefined,
            response,
            estimatedPnl: quote.cashProceeds - leg.estimatedCashCost,
          };
        }
        if (state === "pending" || state === "unknown") {
          return { success: false, response, error: `unwind state ${state}; manual reconciliation required` };
        }
        lastError = response.errorMsg || `unwind status ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { success: false, error: lastError };
}

export async function executeFokBasket(early: ExactBuyLeg, late: ExactBuyLeg): Promise<BasketExecutionResult> {
  const trading = getTradingClient();
  let earlyOrder;
  let lateOrder;
  try {
    [earlyOrder, lateOrder] = await Promise.all([
      trading.createOrder(
        { tokenID: early.tokenId, price: early.limitPrice, size: early.shares, side: Side.BUY },
        orderOptions(early.tickSize, early.negRisk),
      ),
      trading.createOrder(
        { tokenID: late.tokenId, price: late.limitPrice, size: late.shares, side: Side.BUY },
        orderOptions(late.tickSize, late.negRisk),
      ),
    ]);
  } catch (error) {
    return {
      status: "not_filled",
      earlyState: "failed",
      lateState: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let raw: unknown;
  try {
    // One HTTP request; each exact-share leg is FOK. deferExec returns immediately.
    raw = await trading.postOrders([
      { order: earlyOrder, orderType: OrderType.FOK },
      { order: lateOrder, orderType: OrderType.FOK },
    ], false, true);
  } catch (error) {
    return {
      status: "manual_review",
      earlyState: "unknown",
      lateState: "unknown",
      error: `batch submission state unknown: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!Array.isArray(raw) || raw.length !== 2) {
    return {
      status: "manual_review",
      earlyState: "unknown",
      lateState: "unknown",
      error: "batch response did not contain two order results",
    };
  }

  const earlyResponse = asOrderResponse(raw[0]);
  const lateResponse = asOrderResponse(raw[1]);
  const [earlyState, lateState] = await Promise.all([
    settleQuick(earlyResponse),
    settleQuick(lateResponse),
  ]);

  if (held(earlyState) && held(lateState)) {
    return { status: "matched_pending", earlyResponse, lateResponse, earlyState, lateState };
  }
  if (earlyState === "failed" && lateState === "failed") {
    return { status: "not_filled", earlyResponse, lateResponse, earlyState, lateState };
  }
  if (held(earlyState) !== held(lateState) && [earlyState, lateState].includes("failed")) {
    const exposed = held(earlyState) ? early : late;
    const unwind = await unwindExactShares(exposed);
    return {
      status: unwind.success ? "unwound" : "unwind_failed",
      earlyResponse,
      lateResponse,
      earlyState,
      lateState,
      unwind,
    };
  }
  return { status: "matched_pending", earlyResponse, lateResponse, earlyState, lateState };
}
