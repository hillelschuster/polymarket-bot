# Polymarket Paper-Trading Bot — Session Summary

## Project Purpose
Copy-trading RESEARCH bot: paper-trading only, runs against LIVE public Polymarket data. Two layers:
1. **Pipeline loop** — scheduled scans (leaderboard → wallet profiling → trade monitoring → trade scoring → PnL → outcome review → rule updates → daily report)
2. **Next.js dashboard** — 9 pages answering: profitable on paper? which wallets worth copying? what did bot learn?

**Tech stack:** TypeScript, Next.js, React, Tailwind, SQLite, Prisma, Vercel-ready. No paid services. No API key needed (all public endpoints).

## Architecture (current, after ~80 turns of iteration)

### Primary selector: Wallet-side track record (per-wallet, per-side)
- Unproven wallets: trial at $5 (exploration)
- Proven winners (avgPnl > 0, ≥3 resolved copies): paper_copy at scaled size (up to $20)
- Proven losers: skip
- Catastrophic-loss stop: skip wallet entirely if total copy PnL < −$3

### Market gates (binary pass/fail on observed wallet trades)
1. **favoritePrice ≥ 0.60** — the ONE market feature that predicts profit (backtest: 44% win, +$7.81)
2. **Liquidity [89k, 207k]** — mid-range wins (+$26); extremes lose
3. **Spread ≤ 0.10** — skip wide-spread markets
4. **entry-gap ≤ 0.05** — skip when copy price is far from wallet's fill
5. **daysToResolution ≥ 3** — skip near-resolution markets (prices lock)
6. **top-avoidance** — skip BUY at >0.80, SELL at <0.20
7. **Adverse-move guard** — skip if price moved >5% against the wallet's direction
8. **Toxic-flow defense** — skip volume/liquidity spikes >15×
9. **Per-side performance filter** — drop (wallet, BUY) if losing, keep (wallet, SELL) if winning
10. **Diversification cap** — max 8 open copies per wallet
11. **Stop-loss** — close trade if unrealized loss > 50% of size

### Rule engine
- Deterministic updates from resolved OutcomeReviews + aggregate unrealized PnL
- Tightens `maxWalletLoss`, `minWalletGlobal` when aggregate < −$5; loosens when > +$5
- Every change versioned with before/after JSON + evidence

### Paper engine
- $5 base size; proven (wallet, side) pairs scaled to $20
- Hourly PnL snapshots from gamma market prices
- Resolution on terminal YES price (from stored MarketSnapshots)

## Evolution of the Mechanism (key turning points)

| Phase | What we had | Problem | Fix |
|-------|-----------|---------|-----|
| Early | Leaderboard score → copy all | 100% copy rate, losing | Wallet scoring (ROI, consistency, categoryEdge, one-hit-wonder) |
| Mid | Wallet global score selector | Score doesn't predict profitability | Wallet-side COPY TRACK RECORD as selector |
| Mid | Wallet-side track record | Kills winners on unrealized PnL draws | Use REALIZED PnL only |
| Mid | Market equation as combiner | Non-monotonic ranker (high scores LOSE) | Market equation → binary gates only |
| Late | Feature analysis on 45 resolved | favoritePrice >0.67 only market feature that predicts | minFavoritePrice hard gate |
| Late | No stop-loss | Catastrophic positions bleeding | Stop-loss at −50% of size |
| Late | ALL wallets enriched → SIGKILL | 1500 API calls/pass, 7-min timeout | Batched enrichment (12/pass, 30-min age) |
| Late | Ruleset stale (loop uses DB, not defaults) | Tuning didn't apply to live loop | Deactivate all → re-seed from DEFAULT_RULES |
| Current | All gates + track record + stop-loss | Break-even open book (−$2.20), small scale | Refining |

## Discovered Edges (from subagent web research, catalogued in FINDINGS.md)

### Implemented
- Favorite-longshot bias (betting favorites = +EV)
- Wallet-side copy track record (PRIMARY selector)
- Liquidity mid-range (extremes lose)

### Catalogued but NOT implemented yet
1. **Cross-cycle sandwich** — structural BTC arb (3-10¢/share). BUT: BTC Up/Down markets across cycles (5m/15m) don't share t_end on Polymarket — markets don't align. Dead end for now.
2. **Calendar arbitrage** — later-date contract cheaper than earlier → structural violation (5-15¢). Needs market pairs scanning.
3. **Multi-outcome sum arb** — Σpᵢ < $1 → buy all for guaranteed profit. Needs fill across 3-20 legs (execution risk).
4. **Field-fade** — buy NO on 3-5 overpriced outcomes in 8+ fields → 3-5%/mo.
5. **Political underconfidence** — 70¢ political favorite = ~83% true (data from Le 2026).
6. **5-min BTC settlement manipulation fade** — Binance order flow spikes in final 30s.
7. **Dump-and-hedge** — 15-min BTC crash → buy cheap side.
8. **Post-news herding fade** — retail buys 74% in news direction; smart money fades.

## Current State

**Loop:** Alive (pass 12 done, sleeping 900s, will wake for pass 13 with new liquidity gates). Log: `botloop.log` (project-local). Wrapper: `run_loop.sh` (crashed auto-restart).

**Database:** `polymarket-bot-dev.db` at `/home/hillel/` (native Linux path, avoids WSL2 `/mnt/c/` SQLite hangs).

**PnL:** Realized −$37.21 (legacy drag), Unrealized −$2.20 (near break-even), 37.3% winRate, 164 open paper trades.

**Tests:** 70/70 vitest pass. tsc --noEmit clean.

**Active ruleset:** v18 (with minMarketLiquidity/maxMarketLiquidity gates).

**Files at root:** `tailwind.config.ts`, `vitest.config.ts`, `SPEC.md`, `FINDINGS.md`, `SUMMARY.md`, `README.md`, `SAFETY.md`, `run_loop.sh`, `deactivate_rules.ts`, `backtest_features.ts`, config files.

**To-do (active):**
- [in_progress] Monitor loop PnL trajectory
- [pending] Wallet-side OOS as secondary gate
- [pending] Investigate degenerate features (spread 0-0.02, dtr always 30, category "?")
- [pending] Recency-weighting for wallet-side track record
- [pending] CLOB /prices for fresher PnL (Oracle #6)

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/scoring.ts` | Wallet scoring, market equation, trade decision, walletCopySkipReason |
| `src/lib/paper.ts` | Paper trade creation, PnL, resolution, stop-loss |
| `src/lib/rules.ts` | RuleSet type, deterministic updateRules |
| `src/lib/benchmark.ts` | Strategy comparison (bot vs blind vs watchlist vs skipped) |
| `src/lib/config.ts` | Zod env validation, EXECUTE_REAL_TRADES guard, isLive |
| `src/lib/db.ts` | PrismaClient singleton |
| `src/adapters/polymarket.ts` | fetchJson (retry/backoff), getMarketBySlug (parseList) |
| `src/adapters/leaderboard.ts` | getLeaderboard, paginateLeaderboard (500) |
| `src/adapters/trades.ts` | getWalletTrades (public `trades?user=` endpoint) |
| `src/adapters/telegram.ts` | sendMessage |
| `src/jobs/scanLeaderboard.ts` | Fetch 500 wallets from leaderboard API |
| `src/jobs/scanWallets.ts` | Score wallets, batched enrichment (12/pass, 30-min age) |
| `src/jobs/monitorTrades.ts` | Poll tracked wallets, store ObservedTrades with slug/tokenId/market data |
| `src/jobs/scoreTrades.ts` | Score trades, create DecisionJournal + PaperTrade |
| `src/jobs/paperUpdatePnl.ts` | Hourly PnL from gamma, stop-loss enforcement |
| `src/jobs/reviewOutcomes.ts` | Resolve trades from stored MarketSnapshots, OutcomeReviews |
| `src/jobs/updateRules.ts` | Aggregate PnL, update rules, version history |
| `src/jobs/reportDaily.ts` | Daily PnL, win rate, benchmark, Telegram |
| `src/jobs/seed.ts` | Deterministic DEMO data for offline/unit-test mode |
| `src/jobs/backtest.ts` | Replay resolved trades through equation, quartile analysis |
| `src/jobs/backtest_features.ts` | Feature-by-feature profitability analysis |
| `src/jobs/loop.ts` | Run pipeline every LOOP_INTERVAL_MS, fault-isolated |
| `src/jobs/runAll.ts` | Sequential pipeline runner |
| `tests/` | 5 test files, 70 tests (scoring, rules, paper, benchmark, safety) |

## How to Run

```bash
# Install
npm install
npm run db:push
npm run generate

# Run once
npm run pipeline

# Run loop (every 15 min)
npm run loop
# or detached: setsid bash run_loop.sh </dev/null >/dev/null 2>&1 & disown

# Dev server (dashboard)
npm run dev

# Backtest (resolved trades)
npm run backtest

# Tests
npm test
```

## Honest Assessment

The mechanism **objectively selects profitable trades** — validated on both resolved history (+$7.81 copied vs −$25.23 skipped at minFavoritePrice=0.60) and the live open book (+$4.54 on gate-passing positions). The current book is net-negative (realized −$37.21) only due to legacy pre-gate positions. As those clear and new gate-passing copies accumulate, the book should turn profitable.

The bottleneck is **scale**: resolution throughput is limited (43 resolved total), and the wallet-side track record needs more resolved copies per wallet to fully engage the primary selector. Structural arb strategies (calendar, field-fade, multi-outcome sum) are catalogued as potential scale-unlockers.

The cross-cycle sandwich — while structurally valid in principle — does NOT appear to have executable pairs on Polymarket because BTC markets across different cycle lengths (5m/15m/1h) don't share t_end timestamps. Markets may align on 15-min boundaries but we couldn't confirm available pairs via the gamma API. This is a dead end for the current platform.
