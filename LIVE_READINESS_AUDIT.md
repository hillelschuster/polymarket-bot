# Polymarket Bot — Live Readiness Audit

**Audit date:** 2026-08-20  
**Scope:** read-only pre-live review of the repository, launch scripts, live execution paths, sizing, persistence, tests, credentials, and current Polymarket CLOB requirements.  
**Requested bankroll:** `$150`  
**Requested exposure:** up to 10 live positions, preferably `$10` each, with `$100` working.  
**Changes made:** this report only. No source, strategy, config, `.env`, database, or running process was changed.

## Executive verdict

### NO-GO for the intended wallet-copy / political-favorites strategy

The normal bot loop is paper-only. It does not call the live wallet-copy executor, and the political-favorites lane only creates `PaperTrade`/`StrategySignal` records.

`EXECUTE_REAL_TRADES=true` alone cannot make the requested strategy live.

### NO-GO for using the separate calendar executor as a substitute

The only production live-capable path is `runRealtimeCalendar.ts`, which trades a different calendar-arbitrage strategy. It is not wired into the normal launcher, does not implement the requested 10-position wallet-copy plan, and has unresolved live-launch issues around duplicate submission, balance enforcement, supervision, and database coordination.

There is currently no launch command that safely produces the requested behavior without code changes.

## What the normal launcher actually runs

```text
start_bot.ps1
  -> run_loop.bat
    -> run_loop.ps1
      -> src/jobs/loop.ts
        -> src/jobs/runAll.ts
```

Evidence:

- `start_bot.ps1:8-9` launches `run_loop.bat` detached.
- `run_loop.bat:19` launches `run_loop.ps1` and only sets `DATABASE_URL`.
- `run_loop.ps1:197` runs `npx tsx src/jobs/loop.ts`.
- `src/jobs/runAll.ts:31-47` contains the normal fast/slow jobs.
- `src/jobs/runAll.ts:32-37` runs monitor, score, paper PnL, and review jobs.
- `src/jobs/runAll.ts:40-46` runs rules, leaderboard, wallets, politics, calendar scan, and reporting.
- No normal-loop step calls `executeWalletCopyOrder`.

The repository README still describes the project as paper-only:

- `README.md:15-19`: says it does not place real trades or interact with private keys/on-chain contracts.
- `README.md:67-69`: describes the bot as paper-only.

The code contains an experimental live executor, but the documented/main launch path does not use it.

## Critical findings

### P0 — Requested wallet-copy live path is dead code

`src/lib/liveExecution.ts:12-97` defines `executeWalletCopyOrder`, but it has no production caller. The only non-definition reference found is a safety test that checks that the function exists.

`src/jobs/scoreTrades.ts:384-431` creates a `DecisionJournal` and `PaperTrade`; it never calls `executeWalletCopyOrder`.

Consequences:

- Wallet-copy signals cannot place real orders.
- Political-favorites signals cannot place real orders.
- The normal loop remains paper-only regardless of the live environment flag.
- No config-only change can activate the requested strategy.

Required future change: wire an explicitly gated live call into the intended strategy path, with live order persistence and reconciliation. This would be a logic change and was **not** made.

### P0 — Only live-capable path is a different strategy and is off-loop

`src/jobs/runRealtimeCalendar.ts:445-466` is the only executable live entry point. It calls `executeFokBasket` from `src/adapters/execution.ts:330-405` for calendar-arbitrage baskets.

It is not called by:

- `src/jobs/loop.ts`
- `src/jobs/runAll.ts`
- `run_loop.bat`
- `start_bot.ps1`

It is exposed only as:

```text
npm run live:calendar
```

Running that command would not turn on wallet-copy or political-favorites trading. It would start the separate calendar strategy.

### P0 — Requested `$150 / 10 × $10` limits do not exist

Current config in `src/lib/config.ts:19-25`:

```text
LIVE_CALENDAR_BASKET_USD       = 10
LIVE_MAX_TOTAL_EXPOSURE_USD    = 100
LIVE_MAX_OPEN_BASKETS          = 5
LIVE_MAX_DAILY_UNWIND_LOSS_USD = 10
```

The calendar quote treats `$10` as the **combined cash cost of both legs**:

- `src/lib/calendarExecution.ts:31-46` calculates equal shares and requires total two-leg cost to remain under `basketCash`.
- `src/jobs/runRealtimeCalendar.ts:211-215` caps open baskets at 5 and total quoted exposure at $100.

Therefore the current calendar path can have at most:

- 5 baskets;
- 10 token legs;
- approximately `$50` of total exposure if every basket costs `$10`;
- not `$100` working across 10 independent `$10` positions.

The normal wallet-copy paper size is also not fixed at `$10`:

- `src/jobs/scoreTrades.ts:302-307` calculates `$5 + 15 × confidence`, clamped to `$5–$20`.
- That size is paper-only because the function never calls the live executor.

There is no `$150` bankroll model, no 10-position counter, and no minimum `$100` deployed guarantee.

### P0 — No on-chain balance or allowance enforcement

The live risk gates use the bot database’s quoted exposure:

- `src/jobs/runRealtimeCalendar.ts:208-216`
- `src/lib/liveCalendarStore.ts:236-247`
- `src/lib/liveExecution.ts:38-52`

No code queries the actual wallet balance or allowance before deciding that another order fits.

This means the bot does not verify that:

- the intended funder has enough pUSD/USDC for the order;
- the token approvals are present and current;
- the database exposure matches on-chain exposure;
- a stale or split database has not reset the internal exposure count;
- the account can fund the requested total bankroll.

Required future change: enforce the bankroll and position limits against authoritative on-chain/account state, not only local SQLite rows.

## High-severity runtime risks

### Duplicate calendar submissions across processes

`src/jobs/runRealtimeCalendar.ts:252-287` checks `activePairExists()` before inserting a live attempt.

`src/lib/liveCalendarStore.ts:172-191` only makes `attempt_key` unique. The live attempt key includes `Date.now()`:

```text
${pair.key}:live:${submittedAt}
```

Two processes can both pass the pre-check and create different unique attempt keys for the same pair. There is no unique active `pair_key` constraint and no single-instance lock.

`start_bot.ps1` can be launched twice, and the normal loop restart behavior is unconditional.

Required future change: atomic claim/single-instance enforcement before live submission.

### Live calendar process is invisible to the supervision scripts

`scripts/stop_bot.ps1:15-18` and the existing `scripts/check_bot.ps1:6-8` target `run_loop.bat`/`loop.ts`.

They do not target `runRealtimeCalendar.ts` or the `live:calendar` process.

Consequences:

- the normal stop command may not stop the live calendar process;
- the health check may report the bot stopped while the live process remains active;
- a live process can remain running after the operator thinks it was shut down.

Required future change: supervise the actual live process or run it under a process manager with explicit PID/state handling.

### Wallet-copy live orders have no reconciliation path

`src/lib/liveExecution.ts:28-35` blocks all new wallet-copy orders when any `LiveOrder` is `unknown` or `submitted`.

There is no job that reconciles `LiveOrder` rows using the authenticated CLOB order/trade endpoints. The reconciliation in `runRealtimeCalendar.ts:361-407` only handles the raw `live_calendar_baskets` table.

If the wallet-copy path is eventually wired and one submit becomes ambiguous, it can stop all subsequent wallet-copy orders indefinitely until manual intervention.

Required future change: add idempotent live-order reconciliation and resolution handling before activating wallet-copy execution.

### SQLite/process coordination is not live-safe

- `src/lib/db.ts` uses one SQLite database connection without an application-level single-instance lock.
- No WAL setup is performed at application startup.
- The normal loop, dashboard, compaction script, and any manually launched live process can touch the same database.
- `run_loop.bat:21-23` restarts after 10 seconds regardless of exit cause.
- The normal loop has no equivalent graceful shutdown handler; `stop_bot.ps1` force-kills matching processes after waiting for DB quiet.

Two live-capable processes can race on the same SQLite file, cause `SQLITE_BUSY` errors, or maintain divergent exposure state.

### Database path is launch-dependent

`.env.example:2-6` documents a canonical Windows/WSL database path, but:

- `run_loop.bat:5` explicitly sets `file:C:/home/hillel/polymarket-bot-dev.db`.
- `src/lib/config.ts:5` defaults to `file:./dev.db`.
- `npm run live:calendar` does not set `DATABASE_URL` itself.
- The live calendar table is created through raw SQL by `src/lib/liveCalendarStore.ts:86-129`, outside the Prisma schema.

Launching the live command from a shell without the correct process environment can open `dev.db` instead of the canonical database. The loop, dashboard, and live executor can then disagree about state.

## Credentials, `.env`, wallet, and CLOB requirements

### Current local environment state

The repository `.env` file exists, but its variable names currently include only:

```text
DATABASE_URL
EXECUTE_REAL_TRADES
USE_LIVE_DATA
POLYMARKET_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
HERMES_API_KEY
```

No values were read.

The required live credential variable names are absent from the repository `.env`:

- `POLYMARKET_PRIVATE_KEY`
- `CLOB_API_KEY`
- `CLOB_API_SECRET`
- `CLOB_API_PASSPHRASE`
- `POLYMARKET_FUNDER_ADDRESS` when signature type is not 0

The actual parent-process environment was not inspected, so it remains unknown whether those variables are exported externally.

### `.env` permissions are unsafe for secrets

The current `.env` file mode is `0777` (world-readable and world-writable in the inspected filesystem).

Do not put a private key or CLOB secret into that file without first restricting its permissions and confirming it is not exposed through backups, sharing, or process logs. `.env` is listed in `.gitignore`, but that does not protect a world-readable file on the machine.

### Important environment-loading fact

`src/lib/config.ts:33` reads `process.env` directly. There is no `dotenv` import in the TypeScript jobs.

The CLI jobs do not automatically load the repository `.env` file. `run_loop.bat` only sets `DATABASE_URL`.

Therefore, putting live credentials into `.env` and running `npm run live:calendar` is not sufficient. The variables must be present in the process environment, or the launcher must explicitly load them. Adding automatic `.env` loading would be a code/config change and was not made.

### Required CLOB/operator checks

Before any future live activation, verify all of these against the actual Polymarket account:

1. `EXECUTE_REAL_TRADES=true` is present in the live process environment.
2. `LIVE_TRADING_PAUSED` is not `true`.
3. The private key belongs to the intended Polygon signer.
4. `CLOB_API_KEY`, `CLOB_API_SECRET`, and `CLOB_API_PASSPHRASE` are valid L2 credentials for that signer.
5. The configured `POLYMARKET_SIGNATURE_TYPE` matches the account wallet type:
   - EOA: typically type 0;
   - proxy/safe/deposit wallet: the matching type and funder address are required.
6. The signer/funder relationship matches the CLOB account. Do not guess the signature type.
7. The account is funded with the asset required by the current Polymarket account/wallet setup.
8. Both relevant exchange contracts have the required ERC-20 and conditional-token approvals.
9. The account/region is allowed to trade on Polymarket.
10. CLOB order books provide valid tick sizes, minimum order sizes, and enough depth for the requested order.
11. The process handles `401`, `400` balance/allowance failures, `425`, `429`, and `503` without duplicate resubmission.

The local client construction is in `src/adapters/execution.ts:73-101`. It uses:

- `https://clob.polymarket.com`;
- Polygon chain;
- supplied L2 credentials;
- `useServerTime: true`;
- `retryOnError: false`;
- `throwOnError: false`.

The public market WebSocket does not expose wallet identities. It is suitable for anonymous market books/price events, not for discovering wallet-copy addresses.

## Order handling that is present

The calendar executor has some useful mechanics, but they do not make the full system live-ready:

- `src/adapters/execution.ts:242-284`: exact-share FOK buy with fresh book/fee quote and fail-closed price/cash checks.
- `src/adapters/execution.ts:287-328`: FOK unwind attempt for a one-leg exposure.
- `src/jobs/runRealtimeCalendar.ts:306-318`: unresolved/unwind failures halt the calendar process.
- `src/jobs/runRealtimeCalendar.ts:361-407`: pending calendar reconciliation and manual-review halt.

Remaining limitations:

- live realized PnL uses quoted cash cost in `src/lib/liveCalendarStore.ts:258-281`, not authoritative fill accounting;
- missing payout entries default to zero at `src/lib/liveCalendarStore.ts:268-274`;
- wallet-copy orders have no equivalent reconciliation;
- no normal-loop caller reaches the wallet-copy executor.

## Verification results

### Test suite

Command:

```text
npm test
```

Result: **not passing**. The command exceeded the 120-second shell limit after the live safety test timed out.

Observed failures:

- `tests/scoring.test.ts`: 4 failures.
  - liquid/favorable market scoring expectation;
  - favorite-longshot scoring expectation;
  - `segmentFromSlug` is not a function;
  - `bypassesGlobalScoreGate` is not a function.
- `tests/profitabilityPatch.test.ts`: 5 failures.
  - `mainlinePositionSize` is not a function;
  - `segmentFromSlug` is not a function;
  - `unscoredObservedTradeWhere` is not a function.
- `tests/safety.test.ts`: the Lane A live-module import test timed out at 15 seconds.

Other suites reported passing before the command timed out, but the repository cannot be called green.

### TypeScript check

Commands:

```text
./node_modules/.bin/tsc --noEmit --pretty false
```

and the equivalent `tsc --noEmit` invocation both exceeded 120 seconds without diagnostics. A clean typecheck was not established.

## Exact required changes before the requested strategy can go live

These are requirements, not changes made in this audit.

### Code/logic requirements

1. Wire the wallet-copy/political-favorites admission path to a real order function behind the existing explicit live gate.
2. Add a real `$150` bankroll model and enforce:
   - maximum 10 open positions;
   - maximum `$10` per position;
   - maximum `$100` total live exposure;
   - actual balance/allowance checks;
   - no assumption that local SQLite is authoritative.
3. Add live order reconciliation for submitted/unknown/open/resolved states.
4. Add resolution/exit accounting for the hold-to-resolution strategy.
5. Add a single-instance/atomic-claim mechanism before any live order submission.
6. Make the live process observable and stoppable by the supervision scripts.
7. Make the intended canonical database path explicit for every live process.
8. Handle CLOB transient errors and ambiguous submissions without unsafe duplicate orders.
9. Fix the failing tests and complete a clean typecheck before trusting a live launch.

### Operator/environment requirements

These are not substitutes for the missing live wiring:

1. Use a secure process-environment mechanism; do not rely on the current `.env` file.
2. Restrict secret-file permissions before storing any credential.
3. Confirm the actual Polymarket wallet type and signature type.
4. Confirm CLOB L2 credentials, signer/funder relationship, funding, approvals, tick size, minimum order size, and region eligibility.
5. Verify the live process points at the canonical database and is the only live process.
6. Perform an orderless/auth-only readiness check before any funded order.

## What must not be run for the requested launch

- Do not assume `start_bot.ps1` makes the wallet-copy strategy live; it does not.
- Do not set `EXECUTE_REAL_TRADES=true` expecting the normal loop to place wallet-copy orders; there is no caller.
- Do not use `npm run live:calendar` as a substitute without explicitly accepting that it is a different strategy and does not satisfy the requested `$100` working exposure.
- Do not place a live order while the test suite is failing, the typecheck has not completed, the wallet type is unverified, or balance/allowance state is unknown.

## Final decision

**No live launch is ready under the requested constraints.**

The leanest truthful answer is not a parameter tweak. The requested live strategy requires missing execution wiring and live-account controls. The repository can continue running its existing paper loop unchanged while those requirements are addressed in a separate, explicitly reviewed change.

---

## Live Strategy Policy Amendment: Baseball De-listing (2026-09-03)

### Context & Empirical Trigger
Across live trading on real capital, baseball (MLB) produced 0 wins and 3 losses (0.0% win rate, -$25.29 realized PnL), alongside 1 postponed KBO order ($9.82 capital frozen). This turned a profitable non-baseball live ledger (+$10.64, 8W/1L across Tennis, Soccer, and Politics) into a net portfolio loss (-$14.65).

Cross-bot verification confirmed consistent negative performance:
- `polymarket-bot` (Paper, 0.73-0.75 bucket): -$22.87 on $N=25$ trades (68.0% win rate vs 74.0% break-even threshold).
- `polymarket-alpha-vault`: -$255.75 on $N=13$ trades.
- `polymarket-enhanced`: -$40.45 on $N=8$ resolved trades.

### Root Causes
1. **Payoff Asymmetry & Negative EV**: In high-parity sports like baseball, entry prices in the 0.73–0.75 band require a 74% win rate to break even. Empirically, paper baseball win rates were 68.0%, generating negative mathematical expectation (-6.0% EV per dollar risked).
2. **In-Play Market Maker Adverse Selection**: Wallets copied (e.g. `wr0ngw4yb3tt0r`) actively trade both sides in-play. Gating on favorites isolates and copies the small losing hedge leg with full position size while omitting the winning underdog leg.
3. **Weather / Schedule Delays**: Rainouts freeze capital under the `LIVE_MAX_OPEN_POSITIONS=15` cap, blocking higher-velocity trades.

### Operational Policy
- **Live Real-Money Execution**: **Baseball is strictly excluded** (`isBaseballMarket` guard in `scoreTrades.ts` and `liveExecution.ts`). No real-money orders will be placed on MLB, KBO, or NPB markets.
- **Paper Simulation Engine**: **Baseball remains active in paper mode**. Simulated trades will continue to be observed, marked, and resolved in the database to longitudinally assess whether structural edge ever emerges across larger sample sizes ($N > 100$).
- **Enhanced Bot**: The baseball evaluator branch is disabled in `market_scanner.py`, focusing the engine strictly on Tennis.
