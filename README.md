# Hermes Polymarket Copy-Trading Research Bot

Paper-trading-only research bot that runs against **live public Polymarket data**.
Hermes Agent operates the loop; a Vercel-ready Next.js dashboard shows results.

See `docs/SPEC.md` for the full design (architecture, scoring, rules, jobs, pages).

## What it does
- **Wallet lane**: Pulls the Polymarket trader leaderboard (top 500), profiles wallets, monitors for new trades, scores and paper-copies strong candidates.
- **Political Favorites lane**: Scans active political markets for favorites priced 55–80¢ (13–18% underconfidence edge, Le 2026). Creates paper trades automatically.
- Updates paper PnL hourly, reviews outcomes when markets resolve.
- Self-improves scoring rules from performance (logged, no approval needed).
- Sends an end-of-day report via Telegram / Hermes.

## What it does NOT do
- Place real trades. `EXECUTE_REAL_TRADES` is always `false`.
- Read, store, or sign private keys.
- Spend money or interact with any on-chain contract.
- Fake live data. If an API fails, the job stops with the real error.

## Quick start
```bash
cp .env.example .env        # no API key needed — live public data is used by default
npm install
npm run db:push            # sync SQLite schema
npm run seed                # labeled DEMO data (optional; live scan replaces it)
npm run dev                 # dashboard at http://localhost:3000
```

No Polymarket API key is required: the bot reads public leaderboard, market, and
per-wallet trade-history APIs. `POLYMARKET_API_KEY` is only for your own
authenticated CLOB trades (unused in v1). Set `USE_LIVE_DATA=false` to run
purely on the DEMO seed.

## Run the loop
Each step has an npm script (see `package.json`). Run the whole pipeline in order:
```bash
npm run pipeline           # single pass
npm run loop               # continuous 15-min cycle
npm run scan:politics      # political favorites scanner only
```

## Project structure
```
src/
  adapters/   Polymarket API clients (leaderboard, trades, market, telegram, hermes)
  jobs/       Pipeline steps + runAll (full loop) + seed
  lib/        Pure logic: scoring, rules, paper engine, benchmark, db, config
  app/        Next.js dashboard (9 pages) + components
tests/        Vitest suites (scoring, rules, paper, benchmark, safety, politicalFavorites)
prisma/       SQLite schema + dev.db
docs/         SPEC, FINDINGS, SAFETY, research PDF
scripts/      Ad-hoc analysis scripts (backtest_features)
```

## Safety
See `docs/SAFETY.md`.
