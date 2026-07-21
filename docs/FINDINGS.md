# Polymarket Research Bot — Consolidated Findings

Last updated: 2026-07-19. Source: 5 subagent research waves + live backtesting + codebase audit.

---

## Current Mechanism (as of b23)

```
Pipeline: scanLeaderboard(500) → scanWallets(score+enrich) → monitorTrades(fetch)
          → scoreTrades(evaluate) → paperUpdatePnl(update+stop-loss) 
          → reviewOutcomes(resolve) → updateRules(learn) → reportDaily

Trade Decision (scoreTrade):
  1. WALLET-SIDE TRACK RECORD (PRIMARY): 
     - Unproven (count<3) → trial_copy $5
     - Proven winner (realized avgPnl>0, count≥3) → copy at conviction-scaled size ($5-20)
     - Proven loser (realized avgPnl≤0, count≥3) → skip
     - Catastrophic (totalPnl < maxWalletLoss=-$3) → skip all
     - Diversification cap: maxCopiesPerWallet=8
  2. BINARY MARKET GATES:
     - minLiquidity=2000, maxSpread=0.10, minDaysToResolution=3
     - maxEntryGap=0.05 (|livePrice - walletFill|), topThreshold=0.80/bottomThreshold=0.20
     - maxAdverseMove=0.05 (price moved against wallet) 
     - toxicRatio=15 (volume/liquidity)
     - **minFavoritePrice=0.60** (only bet favorites, validated on resolved + live data)
  3. CONVICTION-SCALED: proven (wallet,side) pairs get up to $20; unproven $5
  4. STOP-LOSS: close if unrealized loss > 50% of size (stopLossPct=0.5)
  5. RULES ENGINE learns from aggregate unrealized PnL (tightens maxWalletLoss/minWalletGlobal on drawdown)
```

**Evidence quality:** favoritePrice gate validated on 45 resolved trades (copied +$7.81 at 0.60 vs blind -$21.42) AND live open book (+$4.54 on gate-passing vs -$6.42 on gate-failing). 37.3% winRate, unrealized near break-even.

---

## Codebase Bugs (20 found, 1 fixed this turn)

### Critical
| # | File | Line | Issue | Status |
|---|------|------|-------|--------|
| 1 | reviewOutcomes.ts | 70-71 | `\|\| null` erases valid 0 price → duplicate snapshots | **FIXED** (→ `?? null`) |
| 2 | reportDaily.ts | 26-33 | Benchmark always empty (blind=[]), `beatBlindCopy` always true | PENDING |

### High
| # | File | Line | Issue | 
|---|------|------|-------|
| 3 | scoreTrades.ts | 11 | Uncaught JSON.parse on DB rulesJson |
| 4 | scoring.ts | 48-49 | copyThreshold/watchThreshold dead config |
| 5 | scoring.ts | 81-86 | Six W_* market weights dead config (equation uses hardcoded MKT_W) |
| 6 | scoreTrades.ts | 113 | priceMovementSinceEntry naming hazard for SELL |
| 7 | reviewOutcomes.ts | 50-56 | NaN from empty outcomePrices silently skipped |

### Medium (13 more — see explorer audit b23 for full list)

---

## Research Findings — Trading Strategies

### HIGH FEASIBILITY (paper-bot ready, no auth)

#### 1. Political Underconfidence Fade (Strongest Single Edge)
- **Source:** Le (2026) arXiv:2602.19520 — 292M trades
- **Finding:** Politics markets are 13-18% underconfident. A 70¢ contract → ~83% true probability.
- **Edge:** Bet favorites in politics markets. This is a mechanical calibration correction — the market is wrong.
- **Already partially in-place** via `minFavoritePrice=0.60` but should be category-aware (only politics gets the boost).
- **Edge magnitude:** ~10-15% per position.

#### 2. Cross-Cycle Sandwich (BTC Up/Down)  
- **Source:** dev.to BlueWhale Quant Lab
- **Signal:** BTC Up/Down contracts with different cycle lengths ending at same wall-clock time have different strikes. Buy UP on low-strike + DOWN on high-strike. If total_cost < $1.00 = guaranteed profit.
- **Sweet band:** When price falls between the two strikes, BOTH legs pay $2.
- **Feasibility:** HIGH — public APIs, no auth. Pair detection is key (~33% of cycles can pair).

#### 3. Calendar Arbitrage
- **Source:** Polyguana guide
- **Signal:** "Will X happen by June?" = $0.40 + "Will X happen by Dec?" = $0.35 → mispriced (later date must be worth ≥ earlier). Buy Dec YES + June NO.
- **Edge:** 5-15¢ per $1. Almost nobody uses calendar spreads on Polymarket.

#### 4. Endgame Filter Pipeline (93-97% favorites)
- **Source:** GitHub LainNet-42
- **Signal:** 7-filter pipeline for near-resolution favorites: liquidity>$10K, spread<200bps, <14d resolution, no 8%+ spikes, OB imbalance, $500+ net buy flow.
- **Reported:** 94.7% win rate, 19 trades/18 wins/2 weeks.

#### 5. 12-Hour Crash Mean Reversion
- **Source:** 18.6M price points, multi-source
- **Signal:** After >20% price crash, markets bounce 6.6% in 1hr, 11% in 12hr. Crypto/sports = 78-79% win. Economics/weather = DON'T revert (fundamental).
- **Edge:** ~£0.06-0.11 per $1 position.

#### 6. Dump-and-Hedge (BTC 15-min cycles)
- **Source:** GitHub tsantoso79, clodesnow
- **Signal:** In first 2 min of 15-min BTC cycle, one side dumps ≥15% → buy it + buy other side when still cheap. Sum target = $0.95.
- **Reported:** $8,293 profit from 1,075 arb pairs ($7.72/pair average).

#### 7. Fade Post-News Herding (Behavioral)
- **Source:** OrcaLayer Research
- **Signal:** After breaking news, retail buys in news direction 74% of time. Smart money sells into it 41% of time (most common smart-money action: close existing positions 29%).
- **Edge:** Fade the first 2-11 min post-news surge.

#### 8. 5-min BTC Settlement Manipulation Fade
- **Source:** Dai, Jia & Yu (2026) — settlement manipulation study
- **Signal:** Final 30s of 5-min BTC contracts show manipulation (Binance spot order flow spikes → price reversal). 15-min contracts clean.
- **Edge:** 1-3% per trade, 288 contracts/day. Fade the manipulation spike.

#### 9. Sports Home-Field Underpricing
- **Source:** Dev community analysis
- **Signal:** Polymarket applies only +1.5-2% home-field boost vs reality +3-4%.
- **Edge:** ~100-150 bps on home-team markets.

#### 10. Trap Detector (When NOT to Trade)
- **Source:** GitHub Cuuper22/polymarket_bot  
- **Signal:** Sentiment bearish but price <0.20 → market already priced it in → TRAP. Sentiment bullish but price >0.80 → TRAP. DO NOTHING.
- **Finding:** Trap avoidance was the #1 performance driver in that system.

### MEDIUM FEASIBILITY

#### 11. Multi-Outcome Σpᵢ < $1 Arbitrage
- **Source:** Saguillo et al. (2025) arXiv:2508.03474
- **Signal:** In N-outcome markets, buy ALL outcomes when sum < $1.00. **Median profit $0.60/dollar** — massive inefficiency.
- **Constraint:** Non-atomic fills. 42% of NegRisk markets had opportunities.
- **Sub-strategy (field-fade):** ~65% of large-field markets (8+ outcomes) sum > $1.00. Buy NO on 3-5 most overpriced. **3-5%/month claimed.**

#### 12. Macro News Latency Arb
- **Source:** Torul et al. (2026) — CPI leak study
- **Signal:** Polymarket didn't adjust for 35 MINUTES after CME moved on CPI. Typical events: 2-5 min lag.
- **Edge:** 1-3% per event, 5-10×/month. Monitor CME/Fed futures + BTC perpetuals vs Polymarket.

#### 13. Tournament Bracket Constraints
- **Source:** Kroer et al. (2016), PRED Scanner
- **Signal:** P(Team A wins Q1) + P(Team B wins Q1) should = P(Q1 winner). Routinely violated.
- **Edge:** 10-15% mispricing on Final Four markets vs draw quality.

### LOW / REQUIRES AUTH

#### 14. PROPHET Ensemble (Sharpe 2.14)
- **Source:** Nguyen et al. (2026) — multi-modal ensemble
- **Architecture:** Temporal tower (TFT+TCN) + Language tower (RAG GPT-4 + FinBERT) + Microstructure tower (GAT on OB). BMA fusion.
- **Needs:** Auth for CLOB OB WebSocket, GPU for ML towers. High infra barrier.

#### 15. Longshot Spread Premium Capture
- **Source:** Dubach (2026) — CLOB microstructure
- **Signal:** Spreads widen at extreme prices (<0.15, >0.85). Post limit orders to capture.
- **Needs:** Auth for order placement + maker rebates.

---

## Academic Literature Key Takeaways

1. **Politics is the most distorted category** (Le 2026): 13-18% underconfidence. Favorites are systematically underpriced.
2. **Sports is near-efficient** at short horizons (<48h) — don't expect edge without non-market signal.
3. **Crypto is near-efficient** on Polymarket.
4. **Weather/Entertainment are overconfident** at short horizons → reversal trades.
5. **Prediction market prices are tough to beat.** Pure LLM forecasting adds zero value out-of-sample (Halldorsson 2025). Edges are in microstructure + systematic calibration corrections.
6. **Bettor disagreement confounds Shin's z** (Whelan 2024-25). Don't use raw Shin z as manipulation detector.
7. **40¢-60¢ sweet spot** for favorites (not 93¢+ extremes, which are already priced).
8. **Smart money holds 18-72 hours** (swing-trading), retail holds to resolution. Delta is the edge.
9. **Polymarket leads polls by up to 14 days** in high-vol states (Cordoba & Themistocleous 2025). Markets predict events.

---

## Probability of Future Work (ranked by impact/effort)

| Priority | Item | Type | Impact |
|----------|------|------|--------|
| 1 | Fix remaining HIGH bugs (scoreTrades JSON.parse, dead config) | Bug | Prevent pipeline death |
| 2 | Category-aware favorite gate (politics=0.55, sports=0.65) | Feature | +10-15% edge in politics |
| 3 | Cross-cycle sandwich scanner (BTC cycles) | New strategy | 3-10¢/share structural |
| 4 | Calendar arb scanner | New strategy | 5-15¢/share structural |
| 5 | Fade post-news herding detector | New strategy | 2-5¢/share behavioral |
| 6 | Field-fade (multi-outcome NO) | New strategy | 3-5%/month |
| 7 | Fix reportDaily benchmark (blind-copy tracking) | Bug | Useful metric |
| 8 | MECHANISM.md with changelog | Doc | User-requested |
| 9 | CLOB /prices for fresher PnL | Feature | Accuracy |

---

## Sources

- **Le (2026):** "Decomposing Crowd Wisdom" — arXiv:2602.19520
- **Saguillo et al. (2025):** "Unravelling the Probabilistic Forest" — arXiv:2508.03474
- **Dubach (2026):** "Anatomy of a Decentralized Prediction Market" 
- **Dai, Jia & Yu (2026):** "Settlement Manipulation in Prediction Markets"
- **Torul et al. (2026):** "Informational Inertia" — CPI leak study
- **Nguyen et al. (2026):** "PROPHET: A Multi-Modal Ensemble Framework"
- **Cheng, Yang, Zou (2026):** "Arbitrage Analysis in NBA Markets" — arXiv:2605.00864
- **Cordoba & Themistocleous (2025):** Polymarket 2024 election lead-lag
- **functionSPACE (2026):** "Binary Events: When You Split One Market Into Twenty"
- **Poly Syncer (2026):** "Liquidity Map of Polymarket"
- **OrcaLayer Research:** On-chain trader behavior analysis
- **Dev Community:** Polymarket bot building guides + 18.6M price-point analysis
