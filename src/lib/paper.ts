// Paper trading engine — pure functions, no I/O, no execution. SPEC §8.

export interface PaperSignal {
  walletAddress: string;
  marketId: string;
  outcome: string;
  side: string;
  entryPrice: number;
}

export interface PaperTrade {
  walletAddress: string;
  marketId: string;
  outcome: string;
  side: string;
  entryPrice: number;
  simulatedPositionSize: number;
  status: "open" | "closed" | "resolved";
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number | null;
  openedAt: number;
  closedAt: number | null;
  resolvedAt: number | null;
}

/**
 * Create a paper trade. Size = $5 + ($15 * confidence), clamped to [$5, $20].
 * Never executes — returns a pure data object.
 */
export function createPaperTrade(signal: PaperSignal, confidence: number): PaperTrade {
  const c = Math.max(0, Math.min(1, confidence));
  const size = Math.round((5 + 15 * c) * 100) / 100; // $5–$20
  return {
    walletAddress: signal.walletAddress,
    marketId: signal.marketId,
    outcome: signal.outcome,
    side: signal.side,
    entryPrice: signal.entryPrice,
    simulatedPositionSize: size,
    status: "open",
    currentPrice: signal.entryPrice,
    unrealizedPnl: 0,
    realizedPnl: null,
    openedAt: Date.now(),
    closedAt: null,
    resolvedAt: null,
  };
}

/**
 * Compute unrealized PnL.
 * BUY (YES) side: size * (currentPrice - entryPrice)
 * SELL / NO side: size * (entryPrice - currentPrice)
 */
export function unrealizedPnl(
  side: string,
  entryPrice: number,
  currentPrice: number,
  size: number,
): number {
  if (side.toUpperCase() === "BUY" || side.toUpperCase() === "YES") {
    return Math.round(size * (currentPrice - entryPrice) * 100) / 100;
  }
  return Math.round(size * (entryPrice - currentPrice) * 100) / 100;
}

/**
 * Hourly PnL update. Returns a new PaperTrade with updated currentPrice/unrealizedPnl.
 */
export function hourlyPnl(trade: PaperTrade, currentPrice: number): PaperTrade {
  return {
    ...trade,
    currentPrice,
    unrealizedPnl: unrealizedPnl(trade.side, trade.entryPrice, currentPrice, trade.simulatedPositionSize),
  };
}

/**
 * Close a paper trade early at current price (stop-loss / take-profit).
 * Realizes PnL at currentPrice, marks status="closed". Never executes.
 */
export function closePaperTrade(trade: PaperTrade, currentPrice: number): PaperTrade {
  const rPnl = unrealizedPnl(trade.side, trade.entryPrice, currentPrice, trade.simulatedPositionSize);
  return {
    ...trade,
    currentPrice,
    unrealizedPnl: 0,
    realizedPnl: rPnl,
    status: "closed",
    closedAt: Date.now(),
    resolvedAt: null,
  };
}
export function resolvePaperTrade(
  trade: PaperTrade,
  finalOutcome: "win" | "lose",
): PaperTrade {
  const finalPrice = finalOutcome === "win" ? 1 : 0;
  const rPnl = unrealizedPnl(trade.side, trade.entryPrice, finalPrice, trade.simulatedPositionSize);
  return {
    ...trade,
    currentPrice: finalPrice,
    unrealizedPnl: 0,
    realizedPnl: rPnl,
    status: "resolved",
    closedAt: Date.now(),
    resolvedAt: Date.now(),
  };
}
