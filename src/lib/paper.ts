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
 * Position size is in DOLLARS (cash invested), not shares.
 * Shares purchased = cashInvested / entryPrice
 * PnL = shares * (currentPrice - entryPrice) for long positions
 *     = cashInvested * (currentPrice / entryPrice - 1)
 * 
 * For outcome-based trades (outcome="No"), we track the token price directly:
 * - Buying NO at 0.40 means paying 0.40 per NO token
 * - If NO resolves to 1.00, profit = (1.00 - 0.40) / 0.40 * cashInvested
 */
export function unrealizedPnl(
  side: string,
  entryPrice: number,
  currentPrice: number,
  cashInvested: number,
): number {
  if (entryPrice <= 0) return 0;
  // shares = cashInvested / entryPrice
  // PnL = shares * (currentPrice - entryPrice)
  //     = (cashInvested / entryPrice) * (currentPrice - entryPrice)
  //     = cashInvested * (currentPrice / entryPrice - 1)
  const shares = cashInvested / entryPrice;
  const sideUpper = side.toUpperCase();
  if (sideUpper === "BUY" || sideUpper === "YES" || sideUpper === "LONG") {
    return Math.round(shares * (currentPrice - entryPrice) * 100) / 100;
  }
  // SELL/SHORT: profit when price falls
  return Math.round(shares * (entryPrice - currentPrice) * 100) / 100;
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
