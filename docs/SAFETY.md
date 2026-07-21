# SAFETY

## Why version one is paper-trading only
This bot simulates bets. No order is ever placed on Polymarket. The code path that would
execute a trade does not exist; `EXECUTE_REAL_TRADES` is hard-forced to `false` in
`src/lib/config.ts` and asserted in tests (`tests/safety.test.ts`).

## Why real execution is disabled
Copy-trading carries real financial risk. Paper-trading lets us prove an edge on live data
before any autonomy. Autonomy is a later, explicit, opt-in decision — not a default.

## How autonomy could be added later
A separate, clearly-labeled execution module would be added behind `EXECUTE_REAL_TRADES=true`,
requiring a signing key in a secure secret store, with per-trade confirmation and hard position
limits. It is intentionally absent from this build.

## Risks
- **Stale data:** prices/trades can lag. The bot timestamps everything and skips markets it
  cannot price confidently.
- **Low liquidity:** hard to enter/exit at quoted prices. `minLiquidity` threshold + penalty.
- **Wide spreads:** erode edge. `maxSpread` threshold filters these out.
- **Copy trading:** past performance ≠ future. Wallets can be lucky (one-hit-wonder penalty).
- **Leaderboard wallets can be misleading:** PnL may come from one trade, old markets, or
  illiquid positions. Scoring penalizes all of these.
- **Private keys:** never stored in the app. The read-only Polymarket key cannot sign trades.

No financial advice. Research tool only.
