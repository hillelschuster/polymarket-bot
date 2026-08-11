// Pure wallet & trade scoring functions. SPEC §6.
// All sub-scores 0–100, weights from RuleSet.

export interface WalletInput {
  roi30d: number;
  winRate30d: number;
  resolvedTradeCount30d: number;
  tradeCount30d: number;
  averageLiquidity: number;
  averageSpread: number;
  averageEntryTiming: number;       // days before resolution (earlier entry = better)
  categoryStrengths: Record<string, number>;
  tradePnls: number[];              // individual PnLs for one-hit-wonder detection
  returnVariance: number;           // normalized variance of returns (0..1)
}

export interface WalletScore {
  global: number;
  components: {
    roiScore: number;
    consistency: number;
    copyability: number;
    categoryEdge: number;
    oneHitPenalty: number;
    illiquidPenalty: number;
  };
}

export interface TradeInput {
  walletGlobalScore: number;         // retained for sizing hint; NOT a decision gate
  priceMovementSinceEntry: number;   // fraction (currentPrice - entryPrice), favorable direction
  spread: number;                    // fraction (0..1)
  liquidity: number;                 // in USDC
  volume: number;                    // in USDC (toxic-flow guard)
  timeToResolution: number;          // days
  currentPrice?: number;             // current price of the bet outcome (top avoidance + favorite-longshot)
  side?: string;                     // "BUY" | "SELL" (direction of our copy)
  category?: string;                 // market category for category-aware favorite gate
  thesisClarity?: number;            // retained for compat; unused in the market equation
}

export interface TradeScore {
  score: number;
  decision: "paper_copy" | "watchlist" | "skip";
  reasons: string[];
}

export interface RuleSetValues {
  minWalletGlobal: number;          // never copy from wallets below this global score
  minWalletCopyWinRate: number;     // only copy from wallets whose paper copies win >= this fraction
  minWalletCopyCount: number;       // min copies before we trust the wallet's track record
  minLiquidity: number;
  maxSpread: number;
  maxPriceMovement: number;          // max favorable move since wallet entry (late-entry gate)
  topThreshold: number;            // skip if bet outcome price is nearer than this to the favorable extreme
  maxAdverseMove: number;          // skip if price moved against the wallet's bet by more than this since entry
  maxEntryGap: number;             // skip if absolute price gap since wallet entry exceeds this
  maxWalletLoss: number;           // hard-stop: skip ALL trades from a wallet whose total copy PnL < this (catastrophic-loss protection)
  maxCopiesPerWallet: number;      // concentration cap: max open paper copies per wallet (diversify across wallets)
  stopLossPct: number;             // close open paper trades when unrealized loss exceeds this fraction of size (e.g. 0.5 = -50%)
  // --- Market-variable "equation" (wallet-independent PRIMARY selector) ---
  minFavoritePrice: number;        // hard gate: only copy when betting the favorite (favoritePrice >= this); the one market feature that predicts profit
  minMarketLiquidity: number;      // skip if liquidity below this (extremes lose)
  maxMarketLiquidity: number;      // skip if liquidity above this (backtest: 89k-207k wins, extremes lose)
  liqTarget: number;               // liquidity ceiling for the liquidity score
  minDaysToResolution: number;     // skip markets resolving sooner (prices lock, no edge)
  sweetDaysToResolution: number;   // beyond this, time score decays (variance, no info)
  toxicRatio: number;              // volume/liquidity cap; above = news spike / HFT adverse
  moveGood: number;                // favorable move since entry that earns full momentum score
  ROI_K: number;
  ONE_HIT_RATIO: number;
  ONE_HIT_PENALTY: number;
  ILLIQUID_PENALTY: number;
  SPREAD_PENALTY: number;
  MIN_RESOLVED_TRADES: number;
  MIN_TRADES_PENALTY: number;
  W_roi: number;
  W_cons: number;
  W_copy: number;
  W_cat: number;
  W_wallet: number;
}

// Default rule set values (sensible starting point, not in SPEC — derived from formulas)
//
// LIQUIDITY BAND WARNING: The minMarketLiquidity/maxMarketLiquidity values below
// were derived from only 45 resolved trades. This is a SMALL SAMPLE and the band
// may be overfit. We use WIDE bounds to avoid rejecting valid trades:
// - minMarketLiquidity: $10K (floor to avoid truly illiquid markets)
// - maxMarketLiquidity: $500K (ceiling to avoid HFT-dominated mega-markets)
// These should be re-validated with 200+ resolved trades before tightening.
export const DEFAULT_RULES: RuleSetValues = {
  minWalletGlobal: 35,              // floor: only copy from wallets with real quality signal
  minWalletCopyWinRate: 0.4,        // require 40%+ win rate on our copies before trusting a wallet
  minWalletCopyCount: 3,            // need >=3 copies to judge a wallet's track record (engage filter faster)
  minLiquidity: 2_000,
  maxSpread: 0.10,
  maxPriceMovement: 0.12,            // tighter: skip trades where price already moved >12% in our favor since wallet entry
  topThreshold: 0.75,               // skip BUY when outcome price >0.75 (overfavored extreme); skip SELL when <0.25
  maxAdverseMove: 0.05,             // skip BUY when price dropped >5% since wallet entry (bet already losing); SELL mirror
  maxEntryGap: 0.05,               // skip if |copyPrice - walletFill| > 5% (post-fill entry leak)
  maxWalletLoss: -3,                // stop copying a wallet after it loses $3 total (prevents blow-ups like -$17.96)
  maxCopiesPerWallet: 8,            // cap open copies per wallet so we diversify across many good wallets
  stopLossPct: 0.5,                 // close open paper trades when unrealized loss > 50% of size (cuts catastrophic bleed)
  // Market-variable equation (wallet-independent primary selector)
  minFavoritePrice: 0.60,           // only bet favorites (backtest sweep: 0.60 → 44% win +$7.81; [0.60,0.65) bucket profitable)
  minMarketLiquidity: 10_000,       // WIDENED from 89K: small sample (45 trades) may be overfit
  maxMarketLiquidity: 500_000,      // WIDENED from 207K: avoid HFT-dominated mega-markets only
  liqTarget: 5_000,                 // liquidity ceiling for the liquidity score
  minDaysToResolution: 3,           // skip markets resolving <3d out (prices lock, no edge)
  sweetDaysToResolution: 30,        // beyond 30d the time score decays (variance, no info)
  toxicRatio: 15,                   // volume/liquidity cap; above = news spike / HFT adverse
  moveGood: 0.1,                    // favorable move since entry that earns full momentum score
  ROI_K: 0.5,
  ONE_HIT_RATIO: 0.5,
  ONE_HIT_PENALTY: 15,
  ILLIQUID_PENALTY: 10,
  SPREAD_PENALTY: 5,
  MIN_RESOLVED_TRADES: 3,
  MIN_TRADES_PENALTY: 5,
  W_roi: 0.3,
  W_cons: 0.2,
  W_copy: 0.2,
  W_cat: 0.1,
  W_wallet: 0.1,                 // demoted: wallet identity is NOT a decision gate (equation is)
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Derive a coarse market category from the Polymarket slug prefix.
 * gamma's `category` field is frequently null, so this recovers a real
 * category signal for most wallets (sports/esports/crypto/politics).
 * Returns null when the prefix is unknown (e.g. generic "will-..." slugs).
 */
const CATEGORY_PREFIXES: Record<string, string> = {
  mlb: "sports", nba: "sports", nfl: "sports", nhl: "sports", epl: "sports",
  ucl: "sports", mex: "sports", mls: "sports", fifa: "sports", fifwc: "sports",
  wnba: "sports", ncaaf: "sports", ncaab: "sports", tennis: "sports", golf: "sports",
  ufc: "sports", boxing: "sports", f1: "sports", nascar: "sports",
  dota2: "esports", lol: "esports", cs2: "esports", csgo: "esports", val: "esports",
  valorant: "esports", overwatch: "esports", rl: "esports",
  crypto: "crypto", btc: "crypto", eth: "crypto", sol: "crypto", xrp: "crypto",
  politics: "politics", political: "politics", election: "politics", president: "politics",
};
export function categoryFromSlug(slug?: string | null): string | null {
  if (!slug) return null;
  const tok = slug.split("-")[0].toLowerCase();
  return CATEGORY_PREFIXES[tok] ?? null;
}

/**
 * Category-aware favorite gate thresholds. Research basis:
 * - Politics: Le (2026) 292M trades → 13-18% underconfidence → wider gate captures more edge
 * - Sports/Crypto: near-efficient at short horizons → tighter gate, only strong favorites
 * - Default: current validated baseline (minFavoritePrice=0.60, backtested +$7.81 vs -$21.42 blind)
 */
export const CATEGORY_FAVORITE_GATES: Record<string, number> = {
  politics: 0.55,
  sports: 0.65,
  crypto: 0.65,
  esports: 0.60,
  default: 0.60,
};

/** Returns the category-specific favorite gate, falling back to default. */
export function getFavoriteGate(category: string | null | undefined): number {
  if (!category) return CATEGORY_FAVORITE_GATES.default;
  return CATEGORY_FAVORITE_GATES[category.toLowerCase()] ?? CATEGORY_FAVORITE_GATES.default;
}

/** Saturating ROI score: 0–100. */
function roiScore(roi30d: number, K: number): number {
  return clamp(roi30d / (roi30d + K), 0, 1) * 100;
}

/** Consistency = winRate * (1 - dampened returnVariance) → 0–100.
 *  Variance penalty only applies with resolved history; live directional PnLs are
 *  noisy (mean≈0) so they'd always cap variance→1 and zero out consistency.
 *  Dampener capped at 0.3 so a volatile-but-winning wallet keeps most of its edge. */
function consistency(winRate30d: number, returnVariance: number, resolvedCount: number): number {
  const penalty = resolvedCount >= 3 ? 0.3 * clamp(returnVariance, 0, 1) : 0;
  return winRate30d * (1 - penalty) * 100;
}

/** Copyability = avg of normalized liquidity, spread, tradeFreq, entryTiming → 0–100. */
function copyability(
  avgLiquidity: number,
  avgSpread: number,
  tradeCount30d: number,
  avgEntryTiming: number,
): number {
  const liqScore = clamp(avgLiquidity / 50_000, 0, 1);       // $50k ceiling
  const spreadScore = 1 - clamp(avgSpread / 0.1, 0, 1);       // 10% spread ceiling
  const freqScore = clamp(tradeCount30d / 50, 0, 1);           // 50 trades ceiling
  const timingScore = clamp(avgEntryTiming / 30, 0, 1);        // earlier entry (more days before resolution) = better
  return ((liqScore + spreadScore + freqScore + timingScore) / 4) * 100;
}

/** One-hit-wonder penalty: 15 if top trade > 50% of total PnL, else 0. */
function oneHitPenalty(tradePnls: number[], ratio: number, penalty: number): number {
  const total = tradePnls.reduce((a, b) => a + Math.abs(b), 0);
  if (total === 0) return 0;
  const top = Math.max(...tradePnls.map(Math.abs));
  return top > ratio * total ? penalty : 0;
}

/** Illiquid + wide-spread + few-trades penalties. */
function illiquidPenalty(
  avgLiquidity: number,
  avgSpread: number,
  resolvedCount: number,
  rules: RuleSetValues,
): number {
  let p = 0;
  if (avgLiquidity < rules.minLiquidity) p += rules.ILLIQUID_PENALTY;
  if (avgSpread > rules.maxSpread) p += rules.SPREAD_PENALTY;
  if (resolvedCount < rules.MIN_RESOLVED_TRADES) p += rules.MIN_TRADES_PENALTY;
  return p;
}

/** Main wallet score. */
export function scoreWallet(input: WalletInput, rules = DEFAULT_RULES): WalletScore {
  const rs = roiScore(input.roi30d, rules.ROI_K);
  const cs = consistency(input.winRate30d, input.returnVariance, input.resolvedTradeCount30d);
  const cp = copyability(input.averageLiquidity, input.averageSpread, input.tradeCount30d, input.averageEntryTiming);
  const ce = clamp(Math.max(0, ...Object.values(input.categoryStrengths)) * 100, 0, 100);
  // One-hit-wonder penalty only meaningful with resolved PnLs; live directional PnLs
  // are noise and would falsely flag single large moves.
  const ohp = input.resolvedTradeCount30d >= 3
    ? oneHitPenalty(input.tradePnls, rules.ONE_HIT_RATIO, rules.ONE_HIT_PENALTY)
    : 0;
  const ilp = illiquidPenalty(input.averageLiquidity, input.averageSpread, input.resolvedTradeCount30d, rules);

  const global = clamp(
    rules.W_roi * rs + rules.W_cons * cs + rules.W_copy * cp + rules.W_cat * ce - ohp - ilp,
    0, 100,
  );

  return {
    global: Math.round(global * 100) / 100,
    components: {
      roiScore: Math.round(rs * 100) / 100,
      consistency: Math.round(cs * 100) / 100,
      copyability: Math.round(cp * 100) / 100,
      categoryEdge: Math.round(ce * 100) / 100,
      oneHitPenalty: ohp,
      illiquidPenalty: ilp,
    },
  };
}

/**
 * Wallet-INDEPENDENT trade "equation". Scores a candidate trade purely on market
 * variables — liquidity, spread, time-to-resolution, momentum since entry, and the
 * favorite-longshot bias (betting favorites has positive expected value; longshots are
 * systematically overpriced). This is the PRIMARY selector: the bot's edge comes from
 * these structural market features, NOT from any wallet's identity. If a wallet goes
 * idle, the equation still applies to every other candidate. Research basis: poly-alpha
 * (favorite-longshot / Shin debiasing), QuantPedia longshot bias, Turbine quant playbook
 * (signal = measurable input with economic logic). Fixed internal weights (principled,
 * not data-mined); only the thresholds are tunable by the rules engine.
 */
export interface MarketFeatures {
  side: string;
  currentPrice: number;       // price of the bet outcome (YES price if BUY, NO price if SELL)
  priceMovementSinceEntry: number; // favorable move since wallet entry
  spread: number;
  liquidity: number;
  volume: number;
  daysToResolution: number;
  detectedPrice?: number;      // the wallet's fill price (for entry-gap gate); optional for backward compat
}

const MKT_W = { liq: 0.2, spr: 0.15, time: 0.1, mom: 0.25, fl: 0.3 };

export function scoreTradeByMarket(
  f: MarketFeatures,
  rules = DEFAULT_RULES,
): { score: number; reasons: string[]; skip: boolean } {
  const side = (f.side ?? "BUY").toUpperCase();
  const p = f.currentPrice;
  const reasons: string[] = [];

  // --- Hard gates (microstructure / risk) ---
  const topT = rules.topThreshold;
  const botT = 1 - rules.topThreshold;
  if (side === "BUY" && p > topT)
    return { score: 0, reasons: [...reasons, `price ${p.toFixed(2)} > top ${topT} (top avoidance)`], skip: true };
  if (side === "SELL" && p < botT)
    return { score: 0, reasons: [...reasons, `price ${p.toFixed(2)} < bottom ${botT} (bottom avoidance)`], skip: true };

  // Directional guard: skip when price moved AGAINST the wallet's bet since entry.
  const favorable = side === "SELL" ? -f.priceMovementSinceEntry : f.priceMovementSinceEntry;
  if (-favorable > rules.maxAdverseMove)
    return { score: 0, reasons: [...reasons, `bet moving against us (adverse ${(-favorable).toFixed(2)} > ${rules.maxAdverseMove})`], skip: true };

  // Skip markets resolving too soon (prices lock, no edge left).
  if (f.daysToResolution < rules.minDaysToResolution)
    return { score: 0, reasons: [...reasons, `resolves in ${f.daysToResolution.toFixed(1)}d < ${rules.minDaysToResolution}d`], skip: true };

  // Toxic flow: volume/liquidity spike = news arrival / HFT adverse selection.
  if (f.liquidity > 0 && f.volume / f.liquidity > rules.toxicRatio)
    return { score: 0, reasons: [...reasons, `volume/liquidity ${(f.volume / f.liquidity).toFixed(0)}x > ${rules.toxicRatio} (toxic flow)`], skip: true };

  // Entry-gap guard: skip when we're far behind the wallet's fill (post-fill entry leak).
  // Round to 6 decimal places to avoid IEEE 754 artifacts (0.9 - 0.85 = 0.050000000000000044).
  const entryGap = +Math.abs(f.currentPrice - (f.detectedPrice ?? f.currentPrice)).toFixed(6);
  if (entryGap > rules.maxEntryGap)
    return { score: 0, reasons: [...reasons, `entry gap ${entryGap.toFixed(3)} > ${rules.maxEntryGap}`], skip: true };

  // Liquidity range gate: WIDE bounds to avoid overfitting to small sample.
  // Original 89K-207K band was from only 45 trades — likely overfit.
  // Current bounds: $10K floor (avoid truly illiquid), $500K ceiling (avoid HFT-dominated).
  // Re-validate with 200+ resolved trades before tightening.
  if (rules.minMarketLiquidity > 0 && f.liquidity < rules.minMarketLiquidity)
    return { score: 0, reasons: [...reasons, `liq ${f.liquidity} < min ${rules.minMarketLiquidity}`], skip: true };
  if (rules.maxMarketLiquidity > 0 && f.liquidity > rules.maxMarketLiquidity)
    return { score: 0, reasons: [...reasons, `liq ${f.liquidity} > max ${rules.maxMarketLiquidity}`], skip: true };

  // --- Soft scores (0..1 each) ---
  const liq = clamp(f.liquidity / rules.liqTarget, 0, 1);
  const spr = 1 - clamp(f.spread / rules.maxSpread, 0, 1);
  const time = 1 - clamp((f.daysToResolution - rules.minDaysToResolution) / (rules.sweetDaysToResolution - rules.minDaysToResolution), 0, 1);
  const mom = clamp(favorable / rules.moveGood, 0, 1);
  // Favorite-longshot: longshots are systematically overpriced, so betting the
  // FAVORITE has positive EV. Backtest on 45 resolved trades: favoritePrice Q4
  // (>0.67) → 42% win +$6.27, while underdog buckets lose. So reward HIGHER
  // favoritePrice monotonically (capped at the 0.80 risk cap where top-avoidance
  // already skips — extreme favorites have poor payoff/risk anyway).
  const favoritePrice = side === "BUY" ? p : 1 - p;
  const fl = clamp((favoritePrice - 0.45) / (0.80 - 0.45), 0, 1);

  const raw = MKT_W.liq * liq + MKT_W.spr * spr + MKT_W.time * time + MKT_W.mom * mom + MKT_W.fl * fl;
  const norm = MKT_W.liq + MKT_W.spr + MKT_W.time + MKT_W.mom + MKT_W.fl;
  const score = clamp((raw / norm) * 100, 0, 100);
  reasons.push(`market score ${Math.round(score)} (liq ${liq.toFixed(2)} spr ${spr.toFixed(2)} time ${time.toFixed(2)} mom ${mom.toFixed(2)} fl ${fl.toFixed(2)})`);
  return { score: Math.round(score * 100) / 100, reasons, skip: false };
}

/**
 * Trade score + decision. The market-variable equation (scoreTradeByMarket) provides
 * BINARY SAFETY GATES only (liquidity, spread, time, top/bottom, adverse, entry-gap,
 * toxic-flow). If all gates pass, the decision is "paper_copy" — the wallet-side track
 * record (handled in the scoreTrades job) is the PRIMARY selector for whether to copy
 * and at what size. This makes the bot robust: wallet identity drives selection via
 * proven track record; market gates prevent unsafe executions.
 */
export function scoreTrade(
  trade: TradeInput,
  rules = DEFAULT_RULES,
): TradeScore {
  const mkt = scoreTradeByMarket(
    {
      side: trade.side ?? "BUY",
      currentPrice: trade.currentPrice ?? 0.5,
      priceMovementSinceEntry: trade.priceMovementSinceEntry,
      spread: trade.spread,
      liquidity: trade.liquidity,
      volume: trade.volume ?? 0,
      daysToResolution: trade.timeToResolution,
      detectedPrice: trade.priceMovementSinceEntry != null ? (trade.currentPrice ?? 0.5) - trade.priceMovementSinceEntry : (trade.currentPrice ?? 0.5),
    },
    rules,
  );
  if (mkt.skip) return { score: 0, decision: "skip", reasons: mkt.reasons };
  // Hard gate on the ONE market feature that predicts profit: betting the FAVORITE
  // (favoritePrice high). Backtest on 45 resolved trades: favoritePrice >0.67 → 42%
  // win +$6.27; underdog buckets lose. The combined equation score is a broken ranker
  // (high score loses), so we gate on the proven feature, not the score.
  const side = (trade.side ?? "BUY").toUpperCase();
  const p = trade.currentPrice ?? 0.5;
  const favoritePrice = side === "BUY" ? p : 1 - p;
  // Category-aware gate: politics gets a wider gate (0.55) due to proven 13-18%
  // underconfidence (Le 2026). Falls back to rules.minFavoritePrice when no category.
  const gate = trade.category ? getFavoriteGate(trade.category) : rules.minFavoritePrice;
  if (favoritePrice < gate)
    return { score: Math.round(mkt.score), decision: "skip", reasons: [...mkt.reasons, `favoritePrice ${favoritePrice.toFixed(2)} < gate ${gate}`] };
  // All market gates passed. Wallet track record (handled in scoreTrades.ts) is the
  // PRIMARY selector for sizing/filtering.
  return { score: Math.round(mkt.score), decision: "paper_copy", reasons: mkt.reasons };
}

/** Track record for one (wallet, side) pair, used by the copy-performance filter. */
export interface WalletCopyRecord {
  side: string;
  count: number;          // copies of this (wallet, side)
  avgPnl: number;         // average unrealized PnL per copy
  winRate: number;        // fraction of copies with pnl > 0
  totalPnl: number;       // wallet's TOTAL copy PnL across all sides (catastrophic-loss stop)
  openCount: number;      // wallet's open copy count (diversification cap)
}

/**
 * Pure decision for the copy-performance filter. Returns a skip reason if this
 * (wallet, side) should NOT be copied, else null. Kept pure so the job's learning
 * loop is unit-testable. Three guards:
 *  1. catastrophic-loss stop — a wallet that has lost too much total is dropped entirely;
 *  2. diversification cap — don't pile into one wallet (alternate across many);
 *  3. per-(wallet, side) performance — drop sides that lose on average (BUY loses,
 *     SELL wins, so a wallet's BUY copies get dropped while SELL keeps running).
 */
export function walletCopySkipReason(rec: WalletCopyRecord, rules = DEFAULT_RULES): string | null {
  if (rec.totalPnl < rules.maxWalletLoss)
    return `wallet total copy PnL $${rec.totalPnl.toFixed(2)} < ${rules.maxWalletLoss} (catastrophic-loss stop)`;
  if (rec.openCount >= rules.maxCopiesPerWallet)
    return `wallet already has ${rec.openCount} open copies (diversification cap)`;
  if (rec.count >= rules.minWalletCopyCount && rec.winRate < rules.minWalletCopyWinRate)
    return `${rec.side} copies winRate ${(rec.winRate * 100).toFixed(0)}% < ${(rules.minWalletCopyWinRate * 100).toFixed(0)}% over ${rec.count} copies`;
  if (rec.count >= rules.minWalletCopyCount && rec.avgPnl < 0)
    return `${rec.side} copies avg PnL $${rec.avgPnl.toFixed(2)} < 0 over ${rec.count} copies`;
  return null;
}
