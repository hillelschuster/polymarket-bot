// Benchmark comparison: bot-filtered vs blind vs watchlist vs skipped. SPEC §9.

export interface BenchmarkTrade {
  id: string;
  strategy: "bot" | "blind" | "watchlist" | "skipped";
  pnl: number;
  marketId: string;
  walletAddress: string;
}

export interface BenchmarkResult {
  botFiltered: { count: number; netPnl: number; avgPnl: number };
  blindCopy: { count: number; netPnl: number; avgPnl: number };
  watchlist: { count: number; netPnl: number; avgPnl: number };
  skipped: { count: number; netPnl: number; avgPnl: number };
  missedWinners: BenchmarkTrade[];     // skipped/blind trades that won
  avoidedLosers: BenchmarkTrade[];     // skipped trades that lost (good)
  badCopies: BenchmarkTrade[];         // bot/blind copies that lost
  goodSkips: BenchmarkTrade[];         // skipped trades that would have lost
}

export function compareStrategies(trades: BenchmarkTrade[]): BenchmarkResult {
  const by = (strat: string) => trades.filter(t => t.strategy === strat);

  const sum = (ts: BenchmarkTrade[]) => ts.reduce((s, t) => s + t.pnl, 0);
  const avg = (ts: BenchmarkTrade[]) => (ts.length ? sum(ts) / ts.length : 0);

  const bot = by("bot");
  const blind = by("blind");
  const watch = by("watchlist");
  const skip = by("skipped");

  // missed winners: skipped/blind trades with positive PnL
  const missedWinners = [...skip, ...blind].filter(t => t.pnl > 0);
  // avoided losers: skipped trades with negative PnL (good — ducked a bullet)
  const avoidedLosers = skip.filter(t => t.pnl < 0);
  // bad copies: bot or blind copies that lost
  const badCopies = [...bot, ...blind].filter(t => t.pnl < 0);
  // good skips: skipped trades that would have lost
  const goodSkips = skip.filter(t => t.pnl < 0);

  return {
    botFiltered: { count: bot.length, netPnl: sum(bot), avgPnl: avg(bot) },
    blindCopy: { count: blind.length, netPnl: sum(blind), avgPnl: avg(blind) },
    watchlist: { count: watch.length, netPnl: sum(watch), avgPnl: avg(watch) },
    skipped: { count: skip.length, netPnl: sum(skip), avgPnl: avg(skip) },
    missedWinners,
    avoidedLosers,
    badCopies,
    goodSkips,
  };
}
