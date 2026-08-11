# REVERT-PLAN — restore W29 wallet-copy configuration

Date: 2026-08-11. Status: ACTIVE. Decision owner: Hillel.

## What happened
- Build at commit `91cd0b0` (2026-07-27, live files identical to `290f706`) traded 2026-07-21→07-27: **27 resolved wallet-copy trades, 25W/2L (92.6%), +$145.01**, avg entry 0.702, median hold 131h (entries days before resolution).
- 07-28→08-02: seven edge-relevant rewrites (stop-loss disabled, wallet-loss gate removed, minWalletGlobal bypassed for MLB/UFC/F1, wallet universe top-50→top-200, sizing rewritten to fixed $20/$5, entry gap widened, copy cap raised). Result: median hold collapsed to ~2.8h (entries hours before matches at ~0.73), weekly PnL −$57, −$37, −$6.
- Analysis: `../docs/ANALYSIS-7-POLYMARKET-REVERSE-ENGINEERING.md` (parent folder docs/).

## What this revert does
Restores from `91cd0b0`: scoreTrades.ts, scoring.ts, scanWallets.ts, paperUpdatePnl.ts, paper.ts.
Behavior restored: top-50 quality wallet universe; minWalletGlobal 35 on ALL signals (no bypass); wallet-loss gate −$3; maxCopiesPerWallet 8; maxEntryGap 0.05; stop-loss at 50% unrealized; confidence-driven sizing $5–20.
One NEW parameter (data-justified): `topThreshold 0.80 → 0.75` (the 0.78–0.85 entry band was 6W/5L, −$58.85, −36.9% ROI across all 91 resolved copies).

## Runtime rules
Any active RuleSet row must be deactivated so DEFAULT_RULES run (as in the winning week).

## FREEZE RULE (binding)
No tuning, no "improvements", no new gates for 2 weeks of paper trading. Every change since 07-28 lost money. The bar for the next change: a pre-registered hypothesis written down before the change + replay or A/B evidence.

## Success / kill criteria (after 2 weeks, ~40+ resolved copies)
- ALIVE: WR ≥ 80% at avg entry ≤ 0.72 → consider small real capital, same rules, same freeze.
- MARGINAL: WR 70–80% → keep paper, review entry bands.
- DEAD: WR < ~70% (below break-even for ~0.70 entries) → the edge was regime/decay, not config. Stop spending time on this lane.

## Rollback
`git revert <merge-commit>` restores the HEAD-of-2026-08-11 behavior.
