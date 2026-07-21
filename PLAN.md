# Polymarket Bot — Plan & Current State

**Last updated:** July 21, 2026  
**Repository:** https://github.com/hillelschuster/polymarket-bot (private)

---

## Executive Summary

This is a paper-trading research bot that exploits inefficiencies in Polymarket prediction markets. The system scans live market data, identifies mispriced opportunities, and simulates trades to validate edges before deploying real capital.

**Current phase:** Paper-trading validation  
**Next phase:** Endgame Scanner implementation → live execution with Builder API

---

## Current State

### What's Running

| Component | Status | Details |
|-----------|--------|---------|
| **Loop** | ✅ Running | 15-min cycle, background process |
| **Political Favorites Scanner** | ✅ Active | 4 open paper trades |
| **Wallet Copy Pipeline** | ✅ Active | 676 wallets tracked, 210 trades observed |
| **PnL Tracking** | ✅ Active | Unrealized: -$0.52 |
| **Dashboard** | ⏸️ Available | `npm run dev` → localhost:3000 |

### Open Paper Trades (as of July 21, 2026)

| Market | Outcome | Entry | Current | PnL |
|--------|---------|-------|---------|-----|
| Fed rates Sept 2026 | No | 0.56 | 0.505 | -$0.55 |
| SC Senate GOP nominee | Yes | 0.79 | 0.797 | +$0.03 |
| Russia United majority | Yes | 0.565 | 0.565 | $0.00 |
| Lula Brazil 2026 | Yes | 0.605 | 0.605 | $0.00 |

### Repository Structure

```
polymarket-bot/
├── src/
│   ├── adapters/     # API clients (Polymarket, Telegram, Hermes)
│   ├── app/          # Next.js dashboard (9 pages)
│   ├── jobs/         # Pipeline steps + scanners
│   └── lib/          # Core logic (scoring, rules, paper engine)
├── tests/            # Vitest suites
├── docs/             # SPEC, FINDINGS, SAFETY, research PDF
├── scripts/          # Ad-hoc analysis (backtest_features)
├── prisma/           # SQLite schema + dev.db
└── [config files]    # package.json, tsconfig, tailwind, etc.
```

---

## Strategy Thesis

### Lane 1: Political Favorites (ACTIVE)

**Research basis:** Le (2026), arXiv:2602.19520 — 292M trades analyzed

**Finding:** Politics markets are 13-18% "underconfident." A 70¢ favorite has ~83% true probability.

**Implementation:**
- Scan active political markets (slug/category/question filtering)
- Buy favorites priced 55-85¢ (sweet spot for edge vs. risk)
- Fixed $10 position size during validation
- Hold until resolution

**Current config:**
```typescript
MAX_FAVORITE_PRICE = 0.85
MIN_LIQUIDITY = 5_000
MAX_SPREAD = 0.08
MIN_DAYS_TO_RESOLUTION = 1
MAX_DAYS_TO_RESOLUTION = 90
```

**Problem:** Slow resolution (weeks to months). Good for long-term edge validation, bad for fast income.

---

### Lane 2: Endgame Scanner (PLANNED)

**Thesis:** Markets priced 90-98¢ resolving in <7 days are near-certainties. Buy them, collect 2-10% yield.

**Example:**
- "Will Fed hold rates in July?" → NO at 96¢, resolves in 3 days
- Buy NO at 96¢ → collect $1.00 → **4.2% profit in 72 hours**

**Math:**
- Win rate needed to break even at 95¢ entry: 95%
- Actual win rate of 95¢ favorites: ~97-98%
- Edge: 2-3% per trade
- Annualized: 60%+ APR if compounded daily

**Why this works:**
1. Retail ignores 95¢ markets (boring, small % gain)
2. But 5% in 3 days = 60% APR annualized
3. High frequency (many markets resolve weekly)
4. Fast validation (trades resolve in days, not months)

**Implementation plan:**
1. Scanner: Find 90-98¢ markets resolving <7 days
2. Filters: Liquidity >$5K, spread <5%, binary outcomes only
3. Execution: `@polymarket/clob-client-v2` for real orders
4. Risk: Max $20 per trade, stop-loss at 85¢

**Requirements for live trading:**
- [ ] Polymarket wallet private key
- [ ] USDC on Polygon
- [ ] Builder API credentials (user has signed up)

---

### Lane 3: Wallet Copy-Trading (ACTIVE, PASSIVE)

**Original thesis:** Copy top traders from leaderboard.

**Current state:** 676 wallets tracked, 210 trades observed, 0 paper copies (scoring thresholds too strict).

**Status:** Running but not generating signals. Low priority.

---

## Technical Architecture

### Data Flow

```
Polymarket gamma-api (public, no auth)
        │
        ▼
┌─────────────────────────────────────┐
│  Pipeline (every 15 min)            │
│  1. scanLeaderboard → 500 wallets   │
│  2. scanWallets → score profiles    │
│  3. monitorTrades → observe trades  │
│  4. scoreTrades → evaluate copies   │
│  5. scanPoliticalFavorites → signals│
│  6. paperUpdatePnl → mark-to-market │
│  7. reviewOutcomes → resolve trades │
│  8. updateRules → evolve thresholds │
│  9. reportDaily → Telegram summary  │
└─────────────────────────────────────┘
        │
        ▼
   SQLite (dev.db)
        │
        ▼
   Next.js Dashboard
```

### Key Files

| File | Purpose |
|------|---------|
| `src/jobs/scanPoliticalFavorites.ts` | Political favorites scanner |
| `src/jobs/loop.ts` | Main 15-min loop |
| `src/jobs/runAll.ts` | Pipeline orchestrator |
| `src/lib/scoring.ts` | Trade scoring + category gates |
| `src/adapters/polymarket.ts` | Gamma-api client |
| `prisma/schema.prisma` | Database schema |

### Database Schema (key models)

- **PaperTrade**: Simulated positions (entry, current, PnL, status)
- **StrategySignal**: Scanner-generated signals with metadata
- **WalletProfile**: Tracked trader profiles with scores
- **ObservedTrade**: Trades made by tracked wallets
- **DecisionJournal**: Scoring rationale for each decision

---

## Commands

```bash
# Run the full pipeline once
npm run pipeline

# Run continuous 15-min loop
npm run loop

# Run political scanner only
npm run scan:politics

# Start dashboard
npm run dev

# Run tests
npm test

# Sync database schema
npm run db:push
```

---

## Validation Metrics

### Target: 30 resolved trades

| Metric | Current | Target |
|--------|---------|--------|
| Open trades | 4 | — |
| Resolved trades | 0 | 30 |
| Win rate | — | >55% |
| Avg PnL per trade | — | >$0.50 |

### Timeline

- **Political Favorites:** 2-4 weeks to 30 resolved trades (slow resolution)
- **Endgame Scanner:** 1-2 weeks to 30 resolved trades (fast resolution)

---

## Next Steps

### Immediate (This Week)

1. **Implement Endgame Scanner**
   - [ ] Create `src/jobs/scanEndgame.ts`
   - [ ] Add to pipeline in `runAll.ts`
   - [ ] Test with live data

2. **Prepare Execution Layer**
   - [ ] Install `@polymarket/clob-client-v2`
   - [ ] Create `src/adapters/execution.ts`
   - [ ] Add wallet key to `.env` (user provides)

### Short-term (2 Weeks)

3. **Validate Endgame Scanner**
   - [ ] Accumulate 30 resolved paper trades
   - [ ] Verify win rate >90%
   - [ ] Calculate actual edge

4. **Go Live (Small)**
   - [ ] Enable `EXECUTE_REAL_TRADES=true` for Endgame only
   - [ ] Start with $10-20 positions
   - [ ] Monitor for 1 week

### Medium-term (1 Month)

5. **Scale**
   - [ ] Increase position size based on results
   - [ ] Add more strategy lanes (calendar arb, correlation hedge)
   - [ ] Deploy to cloud for 24/7 uptime

---

## Risk Factors

| Risk | Mitigation |
|------|------------|
| Market resolves against us | Position sizing ($10-20 max) |
| API rate limits | 200ms delays, 15-min intervals |
| Smart contract risk | Only use official CLOB API |
| Regulatory risk | Private repo, no public claims |
| Edge decays | Continuous monitoring, rule evolution |

---

## Research Sources

1. **Le (2026)** — "Calibration Errors in Prediction Markets" (arXiv:2602.19520)
   - 292M trades analyzed
   - Politics markets 13-18% underconfident
   - Favorites systematically underpriced

2. **IMDEA Networks Study** — 86M Polymarket trades (Apr 2024 - Apr 2025)
   - $40M in arbitrage profits captured
   - Avg arbitrage window: 2.7 seconds

3. **Datawallet Strategy Guide** — Top 10 Polymarket strategies
   - Binary complement arbitrage
   - Favorite compounder (90%+ win rate grinding)
   - Cross-platform arbitrage

---

## Safety Invariants

1. **No real trades** unless `EXECUTE_REAL_TRADES=true` explicitly set
2. **No private keys** in code or logs
3. **No on-chain interaction** except via official CLOB API
4. **Fail on error** — API failures stop the job, no silent fallbacks
5. **Paper-first** — All new strategies validate on paper before live

---

## Contact / Notes

- Builder API: User has signed up, credentials pending
- Wallet: User will provide private key when ready for live trading
- Deployment: Consider Railway/Render for 24/7 uptime ($5-10/mo)

---

*This document is the single source of truth for project state and plans. Update as work progresses.*
