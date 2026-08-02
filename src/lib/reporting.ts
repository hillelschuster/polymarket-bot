export interface PnlReportTrade {
  source: string;
  status: string;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
}

export interface PnlBreakdown {
  resolvedWalletCopyPnl: number;
  resolvedStrategyPnl: number;
  legacyClosedStopLossPnl: number;
  openWalletCopyUnrealizedPnl: number;
  openStrategyUnrealizedPnl: number;
  combinedAccountingTotal: number;
  resolvedWalletCopyCount: number;
  resolvedWalletCopyWins: number;
  resolvedWalletCopyWinRate: number;
}

export function summarizePnl(trades: PnlReportTrade[]): PnlBreakdown {
  const resolvedWalletCopy = trades.filter((trade) => trade.source === "wallet_copy" && trade.status === "resolved");
  const resolvedStrategy = trades.filter((trade) => trade.source === "strategy" && trade.status === "resolved");
  const legacyClosed = trades.filter((trade) => trade.status === "closed");
  const openWalletCopy = trades.filter((trade) => trade.source === "wallet_copy" && trade.status === "open");
  const openStrategy = trades.filter((trade) => trade.source === "strategy" && trade.status === "open");

  const resolvedWalletCopyPnl = sum(resolvedWalletCopy, "realizedPnl");
  const resolvedStrategyPnl = sum(resolvedStrategy, "realizedPnl");
  const legacyClosedStopLossPnl = sum(legacyClosed, "realizedPnl");
  const openWalletCopyUnrealizedPnl = sum(openWalletCopy, "unrealizedPnl");
  const openStrategyUnrealizedPnl = sum(openStrategy, "unrealizedPnl");
  const resolvedWalletCopyWins = resolvedWalletCopy.filter((trade) => (trade.realizedPnl ?? 0) > 0).length;

  return {
    resolvedWalletCopyPnl,
    resolvedStrategyPnl,
    legacyClosedStopLossPnl,
    openWalletCopyUnrealizedPnl,
    openStrategyUnrealizedPnl,
    combinedAccountingTotal: resolvedWalletCopyPnl
      + resolvedStrategyPnl
      + legacyClosedStopLossPnl
      + openWalletCopyUnrealizedPnl
      + openStrategyUnrealizedPnl,
    resolvedWalletCopyCount: resolvedWalletCopy.length,
    resolvedWalletCopyWins,
    resolvedWalletCopyWinRate: resolvedWalletCopy.length ? resolvedWalletCopyWins / resolvedWalletCopy.length : 0,
  };
}

function sum(trades: PnlReportTrade[], field: "realizedPnl" | "unrealizedPnl"): number {
  return trades.reduce((total, trade) => total + (trade[field] ?? 0), 0);
}
