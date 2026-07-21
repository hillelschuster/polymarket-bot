import WebSocket from "ws";
import type { OrderResponse } from "@polymarket/clob-client-v2";
import { prisma } from "../lib/db.js";
import { getActiveMarkets, getMarketBySlug, type GammaMarket } from "../adapters/polymarket.js";
import { getFeeModel, type FeeModel } from "../adapters/marketFees.js";
import { findCalendarPairs, outcomeToken } from "../lib/calendarArbitrage.js";
import { quoteCalendarBasket, type CalendarBasketQuote } from "../lib/calendarExecution.js";
import {
  applyMarketMessage,
  marketResolutions,
  RealtimeOrderBook,
} from "../lib/realtimeOrderBook.js";
import {
  executeFokBasket,
  inspectOrderResponse,
  unwindExactShares,
  type ExactBuyLeg,
  type LegSettlement,
} from "../adapters/execution.js";
import { assertLiveTradingConfigured, config, realTradingEnabled } from "../lib/config.js";
import {
  activePairExists,
  createLiveBasket,
  dailyUnwindLoss,
  getExecutionRisk,
  initLiveCalendarStore,
  listFilledLiveBaskets,
  listPendingLiveBaskets,
  resolveLiveMarket,
  updateLiveBasket,
} from "../lib/liveCalendarStore.js";

const MARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const MIN_LIQUIDITY = 5_000;
const MAX_LATE_DAYS = 14;
const MIN_EARLY_HOURS = 6;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const DISCOVERY_MS = 5 * 60_000;
const RECONCILE_MS = 1_000;
const RESOLUTION_MS = 60_000;
const ATTEMPT_COOLDOWN_MS = 30_000;
const PENDING_MAX_AGE_MS = 5 * 60_000;

interface LivePair {
  key: string;
  early: GammaMarket;
  late: GammaMarket;
  earlyToken: string;
  lateToken: string;
  earlyFee: FeeModel;
  lateFee: FeeModel;
}

const books = new Map<string, RealtimeOrderBook>();
const pairs = new Map<string, LivePair>();
const pairKeysByToken = new Map<string, Set<string>>();
const subscribedTokens = new Set<string>();
const inFlight = new Set<string>();
const lastAttemptAt = new Map<string, number>();
let ws: WebSocket | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let reconnect: ReturnType<typeof setTimeout> | null = null;
let discoveryTimer: ReturnType<typeof setInterval> | null = null;
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let resolutionTimer: ReturnType<typeof setInterval> | null = null;
let stopped = false;
let halted = false;

function daysUntil(endDate: string): number {
  return (new Date(endDate).getTime() - Date.now()) / 86_400_000;
}

async function fetchMarkets(): Promise<GammaMarket[]> {
  const markets: GammaMarket[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await getActiveMarkets({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      liquidityMin: MIN_LIQUIDITY,
    });
    markets.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return markets;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R | null>): Promise<R[]> {
  const output: R[] = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      const value = await fn(current);
      if (value != null) output.push(value);
    }
  }));
  return output;
}

async function discoverPairs(): Promise<void> {
  const markets = await fetchMarkets();
  const candidates = findCalendarPairs(markets).filter(({ early, late }) => {
    if (!early.endDate || !late.endDate || !early.conditionId || !late.conditionId) return false;
    if (!early.slug || !late.slug) return false;
    if (daysUntil(early.endDate) < MIN_EARLY_HOURS / 24 || daysUntil(late.endDate) > MAX_LATE_DAYS) return false;
    return early.liquidity >= MIN_LIQUIDITY && late.liquidity >= MIN_LIQUIDITY;
  });

  const found = await mapLimit(candidates, 8, async ({ key, early, late }): Promise<LivePair | null> => {
    const earlyToken = outcomeToken(early, "No");
    const lateToken = outcomeToken(late, "Yes");
    if (!earlyToken || !lateToken || !early.conditionId || !late.conditionId) return null;
    try {
      const [earlyFee, lateFee] = await Promise.all([
        getFeeModel(earlyToken, early.conditionId),
        getFeeModel(lateToken, late.conditionId),
      ]);
      return { key, early, late, earlyToken, lateToken, earlyFee, lateFee };
    } catch {
      return null;
    }
  });

  pairs.clear();
  pairKeysByToken.clear();
  for (const pair of found) {
    pairs.set(pair.key, pair);
    for (const token of [pair.earlyToken, pair.lateToken]) {
      const keys = pairKeysByToken.get(token) ?? new Set<string>();
      keys.add(pair.key);
      pairKeysByToken.set(token, keys);
    }
  }
  syncSubscriptions(new Set(pairKeysByToken.keys()));
  console.log(`realtimeCalendar: markets=${markets.length} pairs=${pairs.size} tokens=${subscribedTokens.size}`);
  connectMarketSocket();
}

function send(payload: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function syncSubscriptions(next: Set<string>): void {
  const add = [...next].filter((token) => !subscribedTokens.has(token));
  const remove = [...subscribedTokens].filter((token) => !next.has(token));
  for (const token of add) subscribedTokens.add(token);
  for (const token of remove) {
    subscribedTokens.delete(token);
    books.delete(token);
  }
  if (add.length) send({ operation: "subscribe", assets_ids: add, custom_feature_enabled: true });
  if (remove.length) send({ operation: "unsubscribe", assets_ids: remove });
}

function connectMarketSocket(): void {
  if (stopped || subscribedTokens.size === 0) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const socket = new WebSocket(MARKET_WS);
  ws = socket;
  socket.on("open", () => {
    books.clear();
    socket.send(JSON.stringify({
      type: "market",
      assets_ids: [...subscribedTokens],
      custom_feature_enabled: true,
    }));
    heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send("PING");
    }, 10_000);
    console.log("realtimeCalendar: websocket connected");
  });
  socket.on("message", (data) => {
    const text = data.toString();
    if (text === "PONG") return;
    try {
      const message = JSON.parse(text) as unknown;
      for (const resolution of marketResolutions(message)) {
        void resolveLiveMarket(resolution.market, { [resolution.winning_asset_id]: 1 });
      }
      for (const token of applyMarketMessage(books, message)) queueToken(token);
    } catch (error) {
      console.warn(`realtimeCalendar: bad websocket message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  socket.on("close", () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    books.clear();
    ws = null;
    if (!stopped) reconnect = setTimeout(connectMarketSocket, 1_000);
  });
  socket.on("error", () => socket.close());
}

function queueToken(tokenId: string): void {
  for (const pairKey of pairKeysByToken.get(tokenId) ?? []) {
    queueMicrotask(() => void evaluatePair(pairKey));
  }
}

function booksAreFresh(early: RealtimeOrderBook, late: RealtimeOrderBook): boolean {
  const now = Date.now();
  return early.hasSnapshot && late.hasSnapshot &&
    now - early.receivedAt <= config.LIVE_BOOK_MAX_AGE_MS &&
    now - late.receivedAt <= config.LIVE_BOOK_MAX_AGE_MS &&
    Math.abs(early.receivedAt - late.receivedAt) <= config.LIVE_BOOK_MAX_SKEW_MS;
}

async function riskGate(quote: CalendarBasketQuote): Promise<string | null> {
  const risk = await getExecutionRisk();
  if (risk.incidents > 0) return "unresolved execution incident";
  if (risk.openCount >= config.LIVE_MAX_OPEN_BASKETS) return "open basket cap";
  if (risk.exposure + quote.cashCost > config.LIVE_MAX_TOTAL_EXPOSURE_USD) return "exposure cap";
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  if (await dailyUnwindLoss(start.getTime()) >= config.LIVE_MAX_DAILY_UNWIND_LOSS_USD) return "daily unwind loss cap";
  return null;
}

function baseRecord(pair: LivePair, quote: CalendarBasketQuote) {
  return {
    pairKey: pair.key,
    earlyMarketId: pair.early.id,
    lateMarketId: pair.late.id,
    earlyConditionId: pair.early.conditionId!,
    lateConditionId: pair.late.conditionId!,
    earlySlug: pair.early.slug!,
    lateSlug: pair.late.slug!,
    earlyTokenId: pair.earlyToken,
    lateTokenId: pair.lateToken,
    shares: quote.shares,
    earlyCashCost: quote.early.cashCost,
    lateCashCost: quote.late.cashCost,
    quotedCombinedCost: quote.combinedCost,
    quotedCashCost: quote.cashCost,
    quotedProfit: quote.guaranteedProfit,
  };
}

async function recordObservation(pair: LivePair, quote: CalendarBasketQuote): Promise<void> {
  const row = await createLiveBasket({
    ...baseRecord(pair, quote),
    attemptKey: `${pair.key}:observe:${Math.floor(Date.now() / 60_000)}`,
    status: "observed",
  });
  if (row) console.log(`OBSERVE cost=${quote.combinedCost.toFixed(4)} profit=$${quote.guaranteedProfit.toFixed(3)} ${pair.early.slug} / ${pair.late.slug}`);
}

function responseJson(response?: OrderResponse): string | null {
  return response ? JSON.stringify(response) : null;
}

async function executeOpportunity(pair: LivePair, quote: CalendarBasketQuote, earlyBook: RealtimeOrderBook, lateBook: RealtimeOrderBook): Promise<void> {
  if (await activePairExists(pair.key)) return;
  const gate = await riskGate(quote);
  if (gate) return;

  const submittedAt = Date.now();
  const row = await createLiveBasket({
    ...baseRecord(pair, quote),
    attemptKey: `${pair.key}:live:${Math.floor(submittedAt / 10_000)}`,
    status: "submitting",
    submittedAt,
  });
  if (!row) return;

  const earlyLeg: ExactBuyLeg = {
    tokenId: pair.earlyToken,
    shares: quote.shares,
    limitPrice: quote.earlyLimitPrice,
    estimatedCashCost: quote.early.cashCost,
    tickSize: earlyBook.tickSize,
    negRisk: earlyBook.negRisk,
  };
  const lateLeg: ExactBuyLeg = {
    tokenId: pair.lateToken,
    shares: quote.shares,
    limitPrice: quote.lateLimitPrice,
    estimatedCashCost: quote.late.cashCost,
    tickSize: lateBook.tickSize,
    negRisk: lateBook.negRisk,
  };
  const result = await executeFokBasket(earlyLeg, lateLeg);
  if (["unwind_failed", "manual_review"].includes(result.status)) halted = true;
  await updateLiveBasket(row.id, {
    status: result.status,
    earlyOrderId: result.earlyResponse?.orderID || null,
    lateOrderId: result.lateResponse?.orderID || null,
    earlyResponseJson: responseJson(result.earlyResponse),
    lateResponseJson: responseJson(result.lateResponse),
    unwindOrderId: result.unwind?.orderId || null,
    unwindResponseJson: responseJson(result.unwind?.response),
    unwindPnl: result.unwind?.estimatedPnl ?? null,
    error: result.error ?? result.unwind?.error ?? null,
    closedAt: ["not_filled", "unwound", "unwind_failed", "manual_review"].includes(result.status) ? Date.now() : null,
  });
  console.log(`${result.status.toUpperCase()} cost=${quote.combinedCost.toFixed(4)} profit=$${quote.guaranteedProfit.toFixed(3)} ${pair.early.slug} / ${pair.late.slug}`);
}

async function evaluatePair(pairKey: string): Promise<void> {
  const pair = pairs.get(pairKey);
  if (!pair || inFlight.has(pairKey)) return;
  if (Date.now() - (lastAttemptAt.get(pairKey) ?? 0) < ATTEMPT_COOLDOWN_MS) return;
  const earlyBook = books.get(pair.earlyToken);
  const lateBook = books.get(pair.lateToken);
  if (!earlyBook || !lateBook || !booksAreFresh(earlyBook, lateBook)) return;

  const quote = quoteCalendarBasket({
    earlyBook: earlyBook.toOrderBook(),
    lateBook: lateBook.toOrderBook(),
    earlyFee: pair.earlyFee,
    lateFee: pair.lateFee,
    basketCash: config.LIVE_CALENDAR_BASKET_USD,
    maxCombinedCost: config.LIVE_CALENDAR_MAX_COMBINED_COST,
    maxLegSpread: config.LIVE_CALENDAR_MAX_LEG_SPREAD,
    minProfit: config.LIVE_CALENDAR_MIN_PROFIT_USD,
  });
  if (!quote) return;

  inFlight.add(pairKey);
  lastAttemptAt.set(pairKey, Date.now());
  try {
    if (!realTradingEnabled || halted) await recordObservation(pair, quote);
    else await executeOpportunity(pair, quote, earlyBook, lateBook);
  } finally {
    inFlight.delete(pairKey);
  }
}

function parseResponse(value: string | null): OrderResponse | null {
  if (!value) return null;
  try { return JSON.parse(value) as OrderResponse; } catch { return null; }
}

function held(state: LegSettlement): boolean {
  return state === "matched" || state === "confirmed";
}

async function reconcilePending(): Promise<void> {
  for (const row of await listPendingLiveBaskets()) {
    const earlyResponse = parseResponse(row.earlyResponseJson);
    const lateResponse = parseResponse(row.lateResponseJson);
    if (!earlyResponse || !lateResponse) {
      await updateLiveBasket(row.id, { status: "manual_review", error: "missing order response", closedAt: Date.now() });
      halted = true;
      continue;
    }
    const [earlyState, lateState] = await Promise.all([
      inspectOrderResponse(earlyResponse),
      inspectOrderResponse(lateResponse),
    ]);
    if (earlyState === "confirmed" && lateState === "confirmed") {
      await updateLiveBasket(row.id, { status: "filled", filledAt: Date.now() });
      continue;
    }
    if (earlyState === "failed" && lateState === "failed") {
      await updateLiveBasket(row.id, { status: "not_filled", closedAt: Date.now() });
      continue;
    }
    if (held(earlyState) !== held(lateState) && [earlyState, lateState].includes("failed")) {
      await updateLiveBasket(row.id, { status: "unwinding" });
      const earlyHeld = held(earlyState);
      const unwind = await unwindExactShares({
        tokenId: earlyHeld ? row.earlyTokenId : row.lateTokenId,
        shares: row.shares,
        limitPrice: 0,
        estimatedCashCost: earlyHeld ? row.earlyCashCost : row.lateCashCost,
      });
      await updateLiveBasket(row.id, {
        status: unwind.success ? "unwound" : "unwind_failed",
        unwindOrderId: unwind.orderId ?? null,
        unwindResponseJson: responseJson(unwind.response),
        unwindPnl: unwind.estimatedPnl ?? null,
        error: unwind.error ?? null,
        closedAt: Date.now(),
      });
      if (!unwind.success) halted = true;
      continue;
    }
    if (row.submittedAt != null && Date.now() - row.submittedAt > PENDING_MAX_AGE_MS) {
      await updateLiveBasket(row.id, { status: "manual_review", error: "order state unresolved after 5 minutes", closedAt: Date.now() });
      halted = true;
    }
  }
}

async function reconcileResolutions(): Promise<void> {
  const rows = await listFilledLiveBaskets();
  const markets = new Map<string, { conditionId: string; slug: string }>();
  for (const row of rows) {
    if (row.earlyResolvedAt == null) markets.set(row.earlyConditionId, { conditionId: row.earlyConditionId, slug: row.earlySlug });
    if (row.lateResolvedAt == null) markets.set(row.lateConditionId, { conditionId: row.lateConditionId, slug: row.lateSlug });
  }
  for (const { conditionId, slug } of markets.values()) {
    try {
      const market = await getMarketBySlug(slug);
      if (!market?.closed || market.clobTokenIds.length !== market.outcomePrices.length) continue;
      const payouts: Record<string, number> = {};
      for (let i = 0; i < market.clobTokenIds.length; i++) {
        const payout = Number(market.outcomePrices[i]);
        if (!Number.isFinite(payout)) continue;
        payouts[market.clobTokenIds[i]] = payout;
      }
      if (Object.keys(payouts).length) await resolveLiveMarket(conditionId, payouts);
    } catch {
      // Retry next pass.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function shutdown(): Promise<void> {
  stopped = true;
  if (heartbeat) clearInterval(heartbeat);
  if (reconnect) clearTimeout(reconnect);
  if (discoveryTimer) clearInterval(discoveryTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (resolutionTimer) clearInterval(resolutionTimer);
  ws?.close();
  await prisma.$disconnect();
}

export async function runRealtimeCalendar(): Promise<void> {
  await initLiveCalendarStore();
  if (realTradingEnabled) assertLiveTradingConfigured();
  halted = (await getExecutionRisk()).incidents > 0;
  console.log(`realtimeCalendar: mode=${realTradingEnabled ? "LIVE" : "OBSERVE"}${halted ? " HALTED" : ""}`);

  await discoverPairs();
  discoveryTimer = setInterval(() => void discoverPairs().catch((error) => console.error("realtimeCalendar discovery:", error)), DISCOVERY_MS);
  reconcileTimer = setInterval(() => void reconcilePending().catch((error) => console.error("realtimeCalendar reconcile:", error)), RECONCILE_MS);
  resolutionTimer = setInterval(() => void reconcileResolutions().catch((error) => console.error("realtimeCalendar resolution:", error)), RESOLUTION_MS);
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

if (require.main === module) {
  runRealtimeCalendar().catch(async (error) => {
    console.error("realtimeCalendar crashed:", error);
    await shutdown();
    process.exitCode = 1;
  });
}
