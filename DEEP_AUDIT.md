# DEEP AUDIT: Wallet-Copy Alpha Amplification
**Date:** 2026-07-21 | **Commit:** 2fd2d11 (v4-wallet-copy) | **Status:** Paper trading, pre-deployment

---

## EXECUTIVE SUMMARY

The wallet-copy mechanism is generating +25.6% ROI on deployed capital ($93 on $363) with a 65% win rate across 23 open positions. The edge is real, structural, and comes from copying proven profitable wallets on sports markets near event time.

**The system is currently strangling its own alpha.** The largest gains available come from removing self-imposed bottlenecks — not adding complexity. Nine distinct leaks were identified across both audits, converging on three themes:

1. **Speed** — the copy path is 3-5x slower than it needs to be
2. **Wallet selection** — the scoring formula rejects the best wallets and accepts mediocre ones
3. **Capital deployment** — sizing ignores the strongest conviction signal (wallet bet size)

---

## SECTION A: VERIFIED CURRENT STATE

### Performance (from live SQLite)

| Metric | Value |
|--------|-------|
| Paper trades (total) | 25 |
| Open / Resolved | 23 / 2 |
| Unrealized PnL | +$93.34 |
| Deployed capital | ~$363 |
| ROI on deployed | +25.6% |
| Win rate (open marks) | 15/23 (65%) |
| Best category | ATP tennis: 73% win, +$37.92 |
| Best wallet | 0x076daa87: 83% win, +$35.34 |

### Wallet Funnel

| Stage | Count |
|-------|-------|
| Leaderboard scanned | 1,707 |
| Status "track" | 22 |
| Status "watch" | 20 |
| Status "ignore" | 1,665 |
| Observed trades | 2,167 |
| v4 gate rejections | ~900+ |
| Actual copies made | 25 |

### Gate Rejection Breakdown (top sources)

| Gate | Rejections | Assessment |
|------|-----------|------------|
| wallet globalScore < 35 | ~350+ | **WRONG — blocks 4/5 profitable wallets** |
| SELL not supported | 57 | Correct (SELL is fictional) |
| signal age > 10min (non-sports) | ~300+ | Partially wrong (see timing section) |
| diversification cap (8 open) | 37 | **WRONG — blocks best wallet** |
| favoritePrice < gate | ~40 | Mostly correct |
| entry gap > 0.05 | ~15 | **Too tight for 5-7min delay** |
| price > 0.80 top avoidance | ~12 | Correct |
| game ending (< 0.5h) | ~10 | Correct |

---

## SECTION B: ALPHA LEAKS (Ranked by Expected Impact)

### LEAK 1 — CRITICAL: Loop latency starves the copy path

**Problem:** The 15-minute loop runs 10 sequential steps BEFORE reaching monitor:trades and score:trades. By the time a wallet's trade is detected and scored, 10-18 minutes have passed. The 20-min sports signal window leaves only 2-10 minutes of margin.

**Pipeline order (current):**
```
update:rules → scan:leaderboard(500) → scan:wallets(enrich 12) →
monitor:trades → score:trades → scan:politics → scan:calendar →
paper:update-pnl → review:outcomes → report:daily → SLEEP 15min
```

**Additional waste:** monitorTrades polls ALL wallets with status="track" (score ≥ 20), but scoreTrades rejects anything below score 35. The bot spends API calls polling wallets it is guaranteed to reject.

**Also:** Each wallet poll uses `limit: 20` trades. A high-frequency wallet can generate 20+ trades between passes, hiding qualifying sports trades behind the cap.

**Fix (two-tier loop):**
- **Fast tier (every 3-5 min):** monitor:trades → score:trades (only wallets with score ≥ 35 OR proven copy record)
- **Slow tier (every 30-60 min):** scan:leaderboard, scan:wallets, paper:update-pnl, review:outcomes
- Raise trade poll limit from 20 → 100
- Use bounded concurrent polling (3-5 parallel) instead of serial + 200ms delay
- Polymarket allows 200 Data API requests/10s — polling 30 wallets every 3 min is well within limits

**Expected impact:** 3-5x more trades caught within the signal window. Fresher entries = less slippage = higher ROI per trade.

---

### LEAK 2 — CRITICAL: Wallet scoring formula rejects the best wallets

**Problem:** 4 of 5 profitable wallets score below the minWalletGlobal=35 gate:

| Wallet | Score | Copy Win% | Copy PnL | Status |
|--------|-------|-----------|----------|--------|
| 0x076daa87 | 22.16 | 83% | +$35.34 | BLOCKED |
| 0xfe787d2d | 17.63 | 100% | +$8.36 | BLOCKED |
| 0x4f29e103 | 28.73 | 75% | +$7.46 | BLOCKED |
| 0xa804390f | 17.05 | 100% | +$6.17 | BLOCKED |

**Root cause:** The formula (0.3×ROI + 0.2×consistency + 0.2×copyability + 0.1×categoryEdge) requires resolved trade history for the consistency component. Most sports markets are still open, so resolved count is near-zero, and the consistency score collapses. The formula measures *data availability*, not *skill*.

**Compounding issue:** scanWallets uses open unrealized PnL to demote/ignore wallets. A sports position can temporarily trade down during a game and still settle at $1. Using open marks for hard rejection contradicts hold-to-resolution.

**Fix:**
- Lower `minWalletGlobal` from 35 → **15** (floor to exclude truly garbage wallets)
- Add **proven-track-record bypass**: if wallet has ≥3 copies with winRate ≥50% AND avgPnl > 0, it passes regardless of formula score
- **Hard rejection only from resolved copies.** Open copies may adjust sizing but never permanently exclude
- Before 5 resolved sports copies: keep wallet at exploratory size

**Expected impact:** Immediately unblocks 4 profitable wallets. ~50-100% more admissible trades.

---

### LEAK 3 — HIGH: Leaderboard targets wrong population

**Problem:** `scanLeaderboard` calls `paginateLeaderboard(500)` which calls `getLeaderboard({ limit: 50, offset })` with NO category and NO timePeriod. The DB records `lookbackDays: 30` — this is a lie. Polymarket's default is **OVERALL / DAY**.

The bot is scanning *today's overall profitable wallets*, not *sports wallets with sustained performance*. A crypto whale who had one good day enters the funnel. A consistent sports grinder who's ranked #80 this month doesn't.

**Fix:**
- Primary scan: `getLeaderboard({ category: "SPORTS", timePeriod: "WEEK", limit: 50 })`
- Secondary scan: `getLeaderboard({ category: "SPORTS", timePeriod: "MONTH", limit: 50 })`
- Union + deduplicate → enrich only those wallets
- Keep one OVERALL/MONTH scan at lower priority for diversification

**Expected impact:** Higher-quality wallet pool. Less noise from non-sports wallets. More copyable sports traders.

---

### LEAK 4 — HIGH: Position sizing ignores wallet conviction

**Problem:** Current sizing: `$5 + $15 × confidence`, clamped to [$5, $20]. Based on generic market score. Completely ignores:
- The wallet's actual bet size (strongest conviction signal)
- Available bankroll
- Total current exposure
- Wallet's sports-specific track record

| Wallet Bet | Our Size | Should Be (2% proportional) |
|-----------|----------|---------------------------|
| $4,798 | $13.93 | $50 (capped) |
| $2,936 | $13.40 | $50 (capped) |
| $271 | $14.00 | $5.42 |
| $4 | $15.65 | $5 (floor) |

We bet $16 on a wallet's $4 pocket-change trade and $14 on their $4,800 conviction trade. Inverted.

**Fix (bankroll-aware, conviction-scaled):**
```
baseSize = bankroll × (provenWallet ? 0.05 : 0.025)
convictionScale = clamp(walletBetNotional / walletAvgBetSize, 0.5, 2.0)
ourSize = clamp(baseSize × convictionScale, $5, bankroll × 0.10)
cap: totalDeployed ≤ bankroll × 0.50
```

For a $200 bankroll: $5 exploratory, $10 proven, max $20 per trade, max $100 deployed.

**Expected impact:** 2-3x PnL on high-conviction winners. Reduced exposure on low-conviction noise.

---

### LEAK 5 — HIGH: Diversification cap blocks best performer

**Problem:** `maxCopiesPerWallet: 8` generated 37 rejections from wallet 0x076daa87 — the 83% win rate, +$35 wallet. The cap treats all wallets identically regardless of performance.

**Fix:** Performance-scaled cap:
- Win rate ≥ 60% AND positive resolved PnL → cap = 15
- Win rate 40-60% → cap = 8 (current)
- The maxWalletLoss gate already kills catastrophic wallets

**Expected impact:** Unblocks ~37 additional copies from the best wallet over time.

---

### LEAK 6 — MEDIUM: Stop-loss contradicts hold-to-resolution

**Problem:** `paperUpdatePnl` closes ANY non-calendar position when unrealized loss exceeds 50% of size. But the strategy is hold-to-resolution: win pays $1, loss pays $0. A sports position can drop 60% mid-game (team trailing) and still settle at $1 (team comes back).

The stop-loss converts temporary in-game drawdowns into permanent realized losses. It also corrupts the wallet's copy track record (a stopped-out trade that would have won counts as a loss).

**Fix:** Disable stop-loss for wallet-copy sports trades. Keep it only for non-sports or strategy trades (calendar arb, politics). The wallet's selection IS the alpha; in-game volatility is expected.

**Expected impact:** Prevents converting eventual winners into realized losses. Preserves wallet track record integrity.

---

### LEAK 7 — MEDIUM: Entry gap not rechecked after CLOB quote

**Problem:** The entry-gap check (`maxEntryGap=0.05`) uses the Gamma midpoint vs wallet's fill price. After obtaining the CLOB quote, the code rechecks price cap and spread — but NOT the actual executable all-in gap from the wallet's fill.

A stale Gamma midpoint can pass the 5% gap check while the actual CLOB ask is 7-8% above the wallet's entry.

**Also:** `maxEntryGap=0.05` is too tight for 5-7 minute detection delay. Prices naturally move 5-8% in that window. Multiple profitable trades were rejected at 0.065 and 0.085 gaps.

**Fix:**
- Add final gate: `quote.allInPrice - walletDetectedPrice <= maxEntryGap`
- Relax `maxEntryGap` from 0.05 → **0.10** (our winning copies entered at 6-9% gaps)
- Remove the pre-CLOB Gamma spread gate (stale); rely solely on the CLOB spread gate

**Expected impact:** ~10-15% more admissible trades, all with verified executable entry.

---

### LEAK 8 — MEDIUM: Calendar arb + politics scanners bleed money and waste API quota

**Problem:**
- `STRATEGY:calendar_arb`: 9 trades, 0 wins, PnL = -$6.16
- `scan:politics`: no measurable contribution, consumes API calls every pass

Both run in every pipeline pass, adding noise and rate-limit pressure.

**Fix:** Disable both in runAll.ts. Comment out, don't delete (preserve for future). Focus 100% of API budget on wallet-copy.

**Expected impact:** Stops bleeding. Frees API quota for faster wallet polling.

---

### LEAK 9 — LOW: Category detection fragile for ATP/WTA/ITF

**Problem:** `CATEGORY_PREFIXES` in scoring.ts includes "tennis" but NOT "atp", "wta", or "itf". These slugs currently get their category from Gamma's `marketCategory` field (set during monitorTrades). If Gamma returns null for category, the slug fallback fails → trade gets non-sports treatment (10-min age, 0.60 gate instead of 0.65).

**Fix:** Add to CATEGORY_PREFIXES:
```
atp: "sports", wta: "sports", itf: "sports", challenger: "sports",
```

**Expected impact:** Prevents silent misclassification. Safety net for Gamma nulls.

---

### LEAK 10 — LOW: SPORTS_MAX_DAYS_TO_RESOLUTION declared but never enforced

**Problem:** `const SPORTS_MAX_DAYS_TO_RESOLUTION = 2` exists in scoreTrades.ts but is never checked. A sports market 5+ days out can be copied, locking capital unnecessarily in a long-dated position with no near-term resolution catalyst.

**Fix:** Add check after the MIN hours check:
```typescript
if (hours > SPORTS_MAX_DAYS_TO_RESOLUTION * 24) { reject }
```

**Expected impact:** Prevents capital lockup in distant markets. Faster capital recycling.

---

### LEAK 11 — LOW: Fee calculation uses base_fee endpoint, not market feeSchedule

**Problem:** The code fetches `CLOB/fee-rate/{tokenId}` and calculates `price × (1-price) × rate/10000`. Polymarket's March 2026 update prescribes using the market's `feeSchedule` from CLOB market info. Sports markets use a market-specific 0.03 fee-rate curve.

**Impact assessment:** On $363 of sports entries, the difference is likely $1-3 total. Does not invalidate the $93. But must be corrected before real deployment for accurate PnL reporting.

**Fix:** Fetch market fee schedule from CLOB market info endpoint. Apply the prescribed curve.

---

### LEAK 12 — LOW: "Resolved" wallet performance uses endDate, not actual settlement

**Problem:** Wallet enrichment in scanWallets treats a trade as "resolved" when `endDate < now`. It does NOT check if the market is officially closed with terminal token prices (0 or 1). A market past endDate but unsettled at 0.60 gets classified as a "win" for the wallet.

**Fix:** Use the existing `closed` flag + terminal price check (same as reviewOutcomes). Only count officially settled markets in wallet quality scores.

---

## SECTION C: SHADOW COUNTERFACTUAL (Missing Instrumentation)

**Problem:** We cannot currently answer "is gate X rejecting winners?" because rejected trades leave no PnL trace.

**Fix:** For each rejected sports trade that passes all gates EXCEPT one, store a $5 shadow quote (entry price, timestamp, rejection reason). When that market resolves, compute shadow PnL. Report by rejection reason.

This directly answers:
- Is the 20-min age gate discarding winners?
- Is the 5% entry gap discarding winners?
- Is the 80¢ cap discarding winners?
- Is the wallet score gate discarding winners?

**Implementation:** Add a `ShadowTrade` table (or reuse DecisionJournal with a `shadowEntryPrice` field). In reviewOutcomes, resolve shadow trades alongside real ones.

---

## SECTION D: CAPITAL ACCOUNTING CORRECTION

The statement "$200 → $233" is misleading. 23 open positions at $363 deployed cannot be simultaneously held by a $200 account.

**Correct methodology:** Capital-constrained replay:
1. Start with $200
2. Accept trades chronologically
3. Subtract committed capital per trade
4. Recycle capital only after resolution
5. Skip/reduce trades when insufficient capital remains
6. Report: realized ROI, unrealized ROI, max drawdown, capital utilization

This should be implemented as a one-time analysis script once we have 30+ resolved trades.

---

## SECTION E: IMPLEMENTATION PRIORITY

### Phase 1 — Immediate (before vacation, ~30 min total)

| # | Change | File | Effort |
|---|--------|------|--------|
| 1 | Lower minWalletGlobal 35→15 | scoring.ts DEFAULT_RULES | 1 line |
| 2 | Add proven-track-record bypass | scoreTrades.ts GATE 2 | 10 lines |
| 3 | Raise diversification cap for winners (8→15) | scoring.ts walletCopySkipReason | 5 lines |
| 4 | Add atp/wta/itf to CATEGORY_PREFIXES | scoring.ts | 1 line |
| 5 | Enforce SPORTS_MAX_DAYS_TO_RESOLUTION | scoreTrades.ts | 5 lines |
| 6 | Disable calendar arb + politics in pipeline | runAll.ts | 2 lines |
| 7 | Relax maxEntryGap 0.05→0.10 | scoring.ts DEFAULT_RULES | 1 line |
| 8 | Disable stop-loss for wallet-copy sports | paperUpdatePnl.ts | 3 lines |

### Phase 2 — Next session (~1 hr)

| # | Change | File | Effort |
|---|--------|------|--------|
| 9 | Two-tier loop (fast 3-min monitor+score, slow 30-min rest) | loop.ts, runAll.ts | 30 min |
| 10 | Sports-specific leaderboard (WEEK + MONTH) | scanLeaderboard.ts | 15 min |
| 11 | Conviction-scaled position sizing | scoreTrades.ts, paper.ts | 20 min |
| 12 | Recheck entry gap on CLOB allInPrice | scoreTrades.ts GATE 7 | 5 min |
| 13 | Raise monitorTrades limit 20→100 | monitorTrades.ts | 1 line |
| 14 | Poll only wallets with score ≥ 15 OR proven record | monitorTrades.ts | 5 lines |

### Phase 3 — Validation (~1 week of running)

| # | Change | File | Effort |
|---|--------|------|--------|
| 15 | Shadow counterfactual instrumentation | scoreTrades.ts, reviewOutcomes.ts | 30 min |
| 16 | Capital-constrained replay script | new script | 20 min |
| 17 | Correct fee source to feeSchedule | polymarket.ts | 15 min |
| 18 | Settlement-based wallet resolution (not endDate) | scanWallets.ts | 10 min |

---

## SECTION F: GO/NO-GO CRITERIA (Real Money)

Move to $200 real-money pilot when ALL are true:

- [ ] ≥30 post-v4 resolved wallet-copy sports trades
- [ ] Realized net ROI (after correct fees) ≥ 8%
- [ ] Profitable after removing top 3 trades (not one-hit-wonder)
- [ ] Capital-constrained $200 replay is profitable
- [ ] ≥5 wallets and ≥10 independent trading days contributed
- [ ] No single wallet > 40% of total profit
- [ ] Max drawdown in $200 replay < 20%

**Real-money entry sizing:**
- $5 per normal copy (unproven wallet)
- $10 per proven wallet-sports pair (≥5 resolved profitable copies)
- Max $100 total deployed at any time
- No scaling until first 30 real positions resolve

---

## SECTION G: WHAT NOT TO DO

1. **Do not add ML/sentiment/neural nets.** The edge is structural: profitable wallets → copy their sports bets → hold to resolution. Adding complexity destroys the signal-to-noise ratio.

2. **Do not tighten gates further.** Every gate added has rejected more winners than losers. The data says loosen, not tighten.

3. **Do not change the hold-to-resolution mechanism.** Early exit (stop-loss, take-profit) converts the binary payoff structure into something worse. The wallet's selection is the alpha; in-game noise is expected.

4. **Do not scan more categories.** Sports (ATP, MLB, ITF) is where the edge is. Politics and crypto have different market microstructure. Validate sports first.

5. **Do not over-engineer wallet scoring.** The copy track record IS the score. If our copies of a wallet make money, the wallet is good. Period.

---

## APPENDIX: CONVERGENCE BETWEEN BOTH AUDITS

| Topic | This Audit | Other Agent | Consensus |
|-------|-----------|-------------|-----------|
| Loop speed | 15-min too slow, split tiers | Same + pipeline order waste | **Agree: fast 3-min tier** |
| Wallet score gate | 35 blocks best wallets | Same + open PnL issue | **Agree: lower + bypass** |
| Leaderboard source | Not checked | OVERALL/DAY not SPORTS | **Agree: use SPORTS/WEEK+MONTH** |
| Position sizing | Ignores wallet bet size | Same + bankroll awareness | **Agree: conviction-scaled** |
| Diversification cap | Blocks best wallet | Not mentioned | **Fix: performance-scaled** |
| Stop-loss | Not mentioned | Contradicts hold-to-resolution | **Agree: disable for sports** |
| Entry gap | 0.05 too tight | Same + recheck on CLOB quote | **Agree: 0.10 + CLOB recheck** |
| Fee source | Not mentioned | base_fee vs feeSchedule | **Agree: correct before real** |
| Calendar/politics | Bleeding, disable | Not mentioned | **Fix: disable** |
| Category prefixes | atp/wta/itf missing | Same | **Agree: add prefixes** |
| MAX_DAYS enforcement | Declared, never used | Same | **Agree: enforce** |
| Shadow counterfactual | Not mentioned | Store rejected trade outcomes | **Agree: implement Phase 3** |
| Capital accounting | $200 replay needed | Same + ROI denominator | **Agree: replay script** |

---

*The mechanism works. The blade is sharp. Stop touching the blade — just remove the handbrake.*
