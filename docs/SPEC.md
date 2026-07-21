# SPEC — Hermes Polymarket Copy-Trading Research Bot

Single source of truth. Paper-trading only, but runs against **LIVE public Polymarket data**
("simulate-everything-live"): real markets, real wallets, real prices — only the bets are simulated.

> Safety invariant: `EXECUTE_REAL_TRADES` is always `false`. No private keys are read, stored,
> signed, or sent. If any upstream API fails, the job throws the real error and stops. No fake
> live data. Demo/seed data is allowed only when explicitly labeled `DEMO`.

---

## 1. Architecture

```
Polymarket public APIs          Hermes (optional LLM)        Telegram (optional)
        │                              │                          │
   adapters/                          │                          │
   (polymarket, leaderboard,          │                          │
    trades, telegram, hermes)         │                          │
        │                              │                          │
   jobs/  (one script per command) ───┤── writes RuleChange ─────┤
        │                              │                          │
   lib/  (scoring, rules, paper,      │                          │
          benchmark, db, config)      │                          │
        │                              │                          │
   Prisma ── SQLite (file: dev.db)    │                          │
        │                              │                          │
   Next.js dashboard (server components read DB directly)
```

Two layers (per PDF):
- **Layer 1 — Operator loop**: plain TS scripts in `jobs/` run on a schedule (cron / Hermes).
  Each script does one thing and exits. State lives in SQLite.
- **Layer 2 — Dashboard**: Next.js App Router, server components query Prisma directly
  (no separate API layer needed for v1). One page per PDF section.

Ponytail choices: no enterprise adapter interfaces, no DI container, no separate API server.
Charts are hand-rolled SVG (no chart dependency). Rule updates are **deterministic heuristics**
(no LLM required for v1; Hermes is an optional reporting/operator hook).

---

## 2. Tech stack & dependencies

- TypeScript, Next.js (App Router), React, Tailwind CSS
- Prisma + SQLite (`@prisma/client`, `prisma`)
- `tsx` to run job scripts directly (no build step for jobs)
- `zod` for env/config validation
- No chart lib, no state manager, no queue. Hermes/Telegram clients are thin `fetch` wrappers.

---

## 3. Data sources & API keys (grounded in current Polymarket docs)

| Source | Endpoint | Auth | Used for |
|---|---|---|---|
| Leaderboard | `GET data-api.polymarket.com/v1/leaderboard` | **public** | top traders (paginate limit≤50, offset≤1000 → 10 pages for 500) |
| Market data | `GET gamma-api.polymarket.com/markets` | **public** | question, category, outcomePrices, liquidity, volume, endDate |
| Prices / spread | `GET clob.polymarket.com/prices?token_ids=&sides=` | **public** | current yes/no price, best bid/ask, spread |
| Wallet trades | `GET data-api.polymarket.com/trades?user=` | **public (no key)** | detect new trades per tracked wallet |

> **Verified:** the public Data API `data-api.polymarket.com/trades?user=0x...` returns any wallet's trade history with **no key and no auth**. The CLOB `clob.polymarket.com/data/trades?maker_address=` (HMAC L2) is only for *your own* trades and is **not** used by v1. So copy-trading research needs **no API key at all**.

**API keys (see §16):**
1. *None required.* Live public data is used by default (`USE_LIVE_DATA=true`).
2. `POLYMARKET_API_KEY` — **optional/unused in v1**. Only relevant if you later want your own authenticated CLOB trade history.
3. `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — optional, for alerts/reports.
4. `HERMES_API_KEY` — optional, for Hermes operator/LLM reports. v1 works without it.

All secrets read from `.env`, validated by `lib/config.ts`, redacted in logs/UI.

---

## 4. Database schema (`prisma/schema.prisma`)

Models (from PDF, 1:1). Key relations:
- `WalletProfile` 1—* `ObservedTrade` (walletAddress)
- `ObservedTrade` 1—1 `DecisionJournal` (observedTradeId)
- `DecisionJournal` 1—1 `PaperTrade` (decisionJournalId)
- `PaperTrade` 1—* `PnlSnapshot` (paperTradeId)
- `DecisionJournal` 1—1 `OutcomeReview` (decisionJournalId)
- `RuleSet` 1—* `RuleChange` (oldRuleSetId / newRuleSetId)
- `LeaderboardScan` 1—* `WalletProfile` (source scan, via scannedAt linkage)

Fields exactly as PDF (id, addresses, scores, json blobs, timestamps). SQLite → use
`String` for JSON, `DateTime` for times, `Float` for scores. Enums as `String` with
`$Enums`-style constants in `lib/config.ts`.

---

## 5. Adapter layer (`src/adapters/`)

Each adapter is a small module exporting typed `fetch` functions + a normalized return type.
On failure: throw `new Error(`<source> API failed: ${status} ${body}`)`. Never swallow.

- `polymarket.ts` — `getMarkets(filter)`, `getMarket(conditionId)`, `getPrices(tokenIds)`,
  `getBook(tokenId)` (best bid/ask/spread/liquidity).
- `leaderboard.ts` — `getLeaderboard({category, timePeriod, limit, offset})` → paginate to N.
- `trades.ts` — `getWalletTrades(address, {after})` (needs `POLYMARKET_API_KEY`); returns
  normalized trades (market, outcome, side, price, size, time).
- `telegram.ts` — `sendMessage(text)` (no-op if not configured).
- `hermes.ts` — `sendReport(payload)` / `operatorPrompt()` (no-op if not configured).

---

## 6. Scoring system (`src/lib/scoring.ts`) — pure, tested

### Wallet score (0–100 global)
Inputs: roi30d, winRate30d, resolvedTradeCount30d, avgLiquidity, avgSpread, avgEntryTiming,
tradeCount30d, categoryStrengths, tradePnls (for one-hit-wonder).

```
roiScore       = clamp(roi30d / (roi30d + ROI_K), 0, 1) * 100      // saturating
// consistency: win rate IS the consistency signal. Variance penalty only with resolved
// history (live directional PnLs are noisy, mean≈0, so they'd always cap variance→1).
consistency    = winRate30d * (1 - 0.3*normalizedReturnVariance)    // 0..1, penalty only if resolvedCount>=3
copyability    = f(avgLiquidity, avgSpread, tradeFreq, entryTiming) // 0..1
// categoryStrengths = per-category win rate (0..1), computed from live+resolved trades (min 2 samples).
categoryEdge   = max(categoryStrengths) * 100                       // 0..100
oneHitPenalty  = resolvedCount>=3 && topTradePnl > ONE_HIT_RATIO*sumPnl ? penalty : 0
globalScore    = W_roi*roiScore + W_cons*consistency + W_copy*copyability
                + W_cat*categoryEdge - oneHitPenalty - illiquidPenalty
```
Weights come from the active `RuleSet`. Penalties: illiquid (avgLiquidity < minLiquidity),
too-wide spread (avgSpread > maxSpread), too-few resolved trades.

### Trade score (0–100)
```
score = W_wallet * walletGlobalScore
      + W_cat    * categoryFit        // wallet.bestCategory == market.category
      + W_move   * (1 - priceMovementSinceEntry/maxMovement)
      + W_spread * (1 - spread/maxSpread)
      + W_liq    * liquidityScore
      + W_time   * timeToResolutionScore
      + W_thesis * thesisClarity
```
Decision (thresholds from RuleSet):
- `paper_copy` if score ≥ copyThreshold AND liquidity ≥ minLiquidity AND spread ≤ maxSpread
  AND priceMovement ≤ maxMovement
- `watchlist` if score ≥ watchThreshold
- else `skip`

All sub-scores are 0–100; weights sum to 1.

---

## 7. Rule engine & self-improvement (`src/lib/rules.ts`)

`RuleSet.rulesJson` holds thresholds + weights:
`copyThreshold, watchThreshold, minLiquidity, maxSpread, maxPriceMovement,
ROI_K, ONE_HIT_RATIO, W_roi, W_cons, W_copy, W_cat, W_move, W_spread, W_liq, W_time, W_thesis`.

`updateRules()` (job `update:rules`):
1. Load benchmark window (last N days): bot-filtered PnL, blind-copy PnL, missed winners,
   avoided losers, and per-bucket performance (by spread / liquidity / priceMovement).
2. For each underperforming bucket, adjust the relevant threshold (e.g. spread-heavy losses →
   lower `maxSpread`; low-liquidity losses → raise `minLiquidity`; late-entry losses → lower
   `maxPriceMovement`; volatile high-ROI wallets → raise `W_cons`).
3. If any change: create new `RuleSet` (version+1, active), insert `RuleChange` with
   `beforeJson/afterJson/evidenceSummary/expectedImprovement`. Never asks for approval (per PDF).
4. Deterministic — same inputs → same change. No LLM needed.

---

## 8. Paper trading engine (`src/lib/paper.ts`)

- On `paper_copy` decision → create `PaperTrade` with `simulatedPositionSize` in [$5, $20],
  scaled by `confidence` (higher confidence → larger, capped at $20).
- `unrealizedPnl = size * (currentPrice - entryPrice)` for BUY (YES) side; sign flips for NO/SELL.
- `paper:update-pnl` job: every hour, refresh prices, append `PnlSnapshot`, update
  `PaperTrade.unrealizedPnl`.
- Resolve when market resolves (price → 0 or 1) or rule says exit → set `realizedPnl`, status.
- `review:outcomes` job: record `OutcomeReview` (priceAfter1h/6h/24h, finalOutcome,
  wasDecisionGood, lessons). Feeds `benchmark` + `updateRules`.

---

## 9. Benchmarks (`src/lib/benchmark.ts`)

Compare 4 strategies over the window: bot-filtered, blind leaderboard copy, watchlist, skipped.
Track: missed winners, avoided losers, bad copies, good skips, late entries avoided,
spread losses avoided. Surfaced on Performance + Reports pages.

---

## 10. Jobs / commands (`src/jobs/*.ts`, wrapped by `package.json` scripts)

| npm script | job | does |
|---|---|---|
| `scan:leaderboard` | scanLeaderboard | pull leaderboard → `LeaderboardScan` + seed `WalletProfile` rows |
| `scan:wallets` | scanWallets | profile top wallets (30d activity, scores, status) |
| `monitor:trades` | monitorTrades | poll `trades` per tracked wallet → `ObservedTrade` |
| `score:trades` | scoreTrades | score new trades → `DecisionJournal` (+ `PaperTrade` on copy) |
| `paper:update-pnl` | paperUpdatePnl | hourly PnL snapshots |
| `review:outcomes` | reviewOutcomes | outcome reviews on resolved markets |
| `update:rules` | updateRules | self-improve thresholds |
| `report:daily` | reportDaily | end-of-day `DailyReport` → Telegram/Hermes |
| `db:migrate` | `prisma migrate` | schema → SQLite |
| `seed` | seed | labeled DEMO data for local dev |
| `dev` | `next dev` | dashboard |
| `test` | `vitest` | tests |

---

## 11. Dashboard pages (`src/app/`)

Server components read Prisma directly. Shared `components/` minimal. Hand-rolled SVG line
chart (`components/LineChart.tsx`). Pages:
1. `/` Overview — PnL, win rate, open positions, tracked wallets, candidates, EOD status,
   latest rule changes, PnL chart.
2. `/rankings` — top-500 table (rank, label, ROI, consistency, copyability, one-hit penalty,
   category, status, reason).
3. `/wallet/[address]` — profile + recent trades + paper perf.
4. `/signals` — new trades, decision, score, reason, risk.
5. `/paper` — simulated trades, PnL, status.
6. `/journal` — every decision w/ score breakdown + good/bad judgment.
7. `/performance` — PnL/win-rate charts, category/wallet perf, benchmark vs blind.
8. `/rules` — active version, thresholds, change history (before/after).
9. `/reports` — EOD + weekly reports.

---

## 12. Hermes operator (`hermes/`)

`operator.md` documents the loop Hermes runs (cron cadence per job). `prompts.ts` builds the
end-of-day report payload. Hermes is optional: without `HERMES_API_KEY`, reports go to Telegram
(if configured) or just persist to `DailyReport`.

---

## 13. File tree

```
package.json  tsconfig.json  next.config.mjs  tailwind.config.ts  postcss.config.mjs
.env.example  .gitignore  README.md  SAFETY.md  vitest.config.ts
prisma/schema.prisma
src/lib/{db,config,scoring,rules,paper,benchmark,time}.ts
src/adapters/{polymarket,leaderboard,trades,telegram,hermes}.ts
src/jobs/{scanLeaderboard,scanWallets,monitorTrades,scoreTrades,paperUpdatePnl,reviewOutcomes,updateRules,reportDaily}.ts
src/app/{layout,page}.tsx + globals.css + 8 route folders + components/LineChart.tsx
hermes/operator.md
tests/{scoring,rules,paper,safety}.test.ts
```

---

## 14. Implementation order (phases)

1. Config + schema + db client + `.env.example` + SPEC (this phase)
2. Adapters (polymarket, leaderboard, trades) + config validation
3. Scoring + rules + paper + benchmark (pure libs, with tests)
4. Jobs wiring (scan → profile → monitor → score → pnl → review → rules → report)
5. Dashboard pages + LineChart
6. Hermes/Telegram + README/SAFETY
7. `seed` (DEMO) + run tests + verify locally

---

## 15. Testing (`vitest`)

- `scoring.test.ts` — wallet score, one-hit-wonder penalty, copyability, trade score, decisions
- `rules.test.ts` — rule versioning, automatic threshold changes + logging
- `paper.test.ts` — paper trade creation, PnL math, resolve
- `benchmark.test.ts` — strategy comparison
- `safety.test.ts` — `EXECUTE_REAL_TRADES` guard, no private-key reads, API failure throws

---

## 16. API keys required (ACTION FOR USER)

| Var | Required? | Purpose |
|---|---|---|
| *(none)* | — | Live public data works with **no key**. `USE_LIVE_DATA=true` (default). |
| `POLYMARKET_API_KEY` | optional / unused v1 | only for your own CLOB trade history later |
| `TELEGRAM_BOT_TOKEN` | optional | alerts + EOD report |
| `TELEGRAM_CHAT_ID` | optional | alert target |
| `HERMES_API_KEY` | optional | Hermes operator/LLM reports |

No key is needed to run live. Set `USE_LIVE_DATA=false` to run purely on labeled DEMO seed data.
Everything else degrades gracefully.
