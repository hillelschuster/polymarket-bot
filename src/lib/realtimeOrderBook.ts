import type { OrderBook, OrderLevel } from "../adapters/polymarket.js";

interface BookMessage {
  event_type: "book";
  market: string;
  asset_id: string;
  bids?: OrderLevel[];
  asks?: OrderLevel[];
  min_order_size?: string;
  tick_size?: string;
  neg_risk?: boolean;
}

interface PriceChange {
  asset_id: string;
  price: string;
  size: string;
  side: string;
}

interface PriceChangeMessage {
  event_type: "price_change";
  market: string;
  price_changes?: PriceChange[];
}

interface TickSizeMessage {
  event_type: "tick_size_change";
  asset_id: string;
  market: string;
  new_tick_size: string;
}

export interface MarketResolvedMessage {
  event_type: "market_resolved";
  market: string;
  winning_asset_id: string;
  winning_outcome?: string;
  timestamp?: string;
}

function level(raw: OrderLevel): { price: number; size: number } | null {
  const price = Number(raw.price);
  const size = Number(raw.size);
  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || price >= 1 || size < 0) return null;
  return { price, size };
}

export class RealtimeOrderBook {
  readonly assetId: string;
  market = "";
  minOrderSize?: string;
  tickSize?: string;
  negRisk?: boolean;
  receivedAt = 0;
  hasSnapshot = false;
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();

  constructor(assetId: string) {
    this.assetId = assetId;
  }

  applySnapshot(message: BookMessage): void {
    this.market = message.market;
    this.bids.clear();
    this.asks.clear();
    for (const raw of message.bids ?? []) this.set(this.bids, raw);
    for (const raw of message.asks ?? []) this.set(this.asks, raw);
    this.minOrderSize = message.min_order_size ?? this.minOrderSize;
    this.tickSize = message.tick_size ?? this.tickSize;
    this.negRisk = message.neg_risk ?? this.negRisk;
    this.receivedAt = Date.now();
    this.hasSnapshot = true;
  }

  applyChange(change: PriceChange, market: string): void {
    const side = change.side.toUpperCase() === "BUY" ? this.bids : this.asks;
    this.market = market || this.market;
    this.set(side, { price: change.price, size: change.size });
    this.receivedAt = Date.now();
  }

  applyTickSize(value: string): void {
    this.tickSize = value;
    this.receivedAt = Date.now();
  }

  toOrderBook(): OrderBook {
    const build = (values: Map<number, number>, descending: boolean): OrderLevel[] =>
      [...values.entries()]
        .filter(([, size]) => size > 0)
        .sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0])
        .map(([price, size]) => ({ price: String(price), size: String(size) }));
    return {
      market: this.market,
      asset_id: this.assetId,
      bids: build(this.bids, true),
      asks: build(this.asks, false),
      min_order_size: this.minOrderSize,
      tick_size: this.tickSize,
      neg_risk: this.negRisk,
      timestamp: String(this.receivedAt),
    };
  }

  private set(target: Map<number, number>, raw: OrderLevel): void {
    const parsed = level(raw);
    if (!parsed) return;
    if (parsed.size === 0) target.delete(parsed.price);
    else target.set(parsed.price, parsed.size);
  }
}

export function applyMarketMessage(books: Map<string, RealtimeOrderBook>, raw: unknown): string[] {
  const messages = Array.isArray(raw) ? raw : [raw];
  const updated = new Set<string>();
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    if (message.event_type === "book") {
      const bookMessage = message as unknown as BookMessage;
      if (!bookMessage.asset_id) continue;
      const book = books.get(bookMessage.asset_id) ?? new RealtimeOrderBook(bookMessage.asset_id);
      book.applySnapshot(bookMessage);
      books.set(bookMessage.asset_id, book);
      updated.add(bookMessage.asset_id);
    } else if (message.event_type === "price_change") {
      const changeMessage = message as unknown as PriceChangeMessage;
      for (const change of changeMessage.price_changes ?? []) {
        if (!change.asset_id) continue;
        const book = books.get(change.asset_id) ?? new RealtimeOrderBook(change.asset_id);
        book.applyChange(change, changeMessage.market);
        books.set(change.asset_id, book);
        updated.add(change.asset_id);
      }
    } else if (message.event_type === "tick_size_change") {
      const tickMessage = message as unknown as TickSizeMessage;
      if (!tickMessage.asset_id) continue;
      const book = books.get(tickMessage.asset_id) ?? new RealtimeOrderBook(tickMessage.asset_id);
      book.applyTickSize(tickMessage.new_tick_size);
      books.set(tickMessage.asset_id, book);
      updated.add(tickMessage.asset_id);
    }
  }
  return [...updated];
}

export function marketResolutions(raw: unknown): MarketResolvedMessage[] {
  const messages = Array.isArray(raw) ? raw : [raw];
  return messages.filter((value): value is MarketResolvedMessage => {
    if (!value || typeof value !== "object") return false;
    const message = value as Partial<MarketResolvedMessage>;
    return message.event_type === "market_resolved" && Boolean(message.market) && Boolean(message.winning_asset_id);
  });
}

export function worstAskForShares(book: OrderBook, shares: number): number | null {
  if (!(shares > 0)) return null;
  let remaining = shares;
  const asks = [...(book.asks ?? [])]
    .map(level)
    .filter((x): x is { price: number; size: number } => x !== null && x.size > 0)
    .sort((a, b) => a.price - b.price);
  for (const ask of asks) {
    remaining -= Math.min(remaining, ask.size);
    if (remaining <= 1e-8) return ask.price;
  }
  return null;
}

export function worstBidForShares(book: OrderBook, shares: number): number | null {
  if (!(shares > 0)) return null;
  let remaining = shares;
  const bids = [...(book.bids ?? [])]
    .map(level)
    .filter((x): x is { price: number; size: number } => x !== null && x.size > 0)
    .sort((a, b) => b.price - a.price);
  for (const bid of bids) {
    remaining -= Math.min(remaining, bid.size);
    if (remaining <= 1e-8) return bid.price;
  }
  return null;
}
