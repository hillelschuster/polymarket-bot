# Important Notes for Future Agents

This is the retained design and research context beyond `AGENTS.md`, `README.md`,
current code, and git history. Code and the active database are authoritative for
current behavior; this document preserves reasoning and research that code alone
cannot express.

## Operating model

- Paper-trade against **live public Polymarket data**. Never place real trades,
  read private keys, sign transactions, or replace failed upstream data with
  fake data.
- The validated core thesis is: copy skilled wallets, buy favorites, hold to
  resolution. New strategies need live paper evidence before promotion.
- The public leaderboard, Gamma market, CLOB price/book, and public wallet-trade
  endpoints are sufficient for the core loop. Authenticated CLOB history is only
  relevant to this account's own trades.
- Keep the system lean: scheduled TypeScript jobs own SQLite state and the
  Next.js dashboard reads it directly. Do not add an API server, DI container,
  queue, state manager, or chart library without a demonstrated profit reason.
  Hermes and Telegram are optional reporting hooks, not strategy dependencies.

## Current strategy and admission rationale

Consult active code and tests for thresholds and formulas. The durable rationale:

- A wallet's own PnL is insufficient. Its signal must retain executable upside
  after our entry, have adequate liquidity and spread, and show limited movement
  from the wallet's fill.
- Known profitable `(wallet, side)` pairs can receive conviction-scaled sizing;
  unproven wallets receive a small trial; proven losers and catastrophic wallets
  are skipped. Diversification prevents one wallet from consuming the book.
- Binary-market gates avoid illiquid, stale, toxic, late, and extreme entries.
  The favorite gate is deliberate: `minFavoritePrice=0.60` produced +$7.81 on
  45 resolved copies versus -$21.42 blind, and +$4.54 for open-book passers
  versus -$6.42 for failures in the July 2026 snapshot. Keep measuring it; do
  not treat the snapshot as permanent truth.
- Scoring should consider wallet quality, category fit, entry movement, spread,
  liquidity, time to resolution, and thesis clarity. Rule changes must be
  deterministic, evidence-backed, versioned, and attributable—no LLM chooses
  trading parameters.
- Preserve an auditable decision, PnL snapshots, final resolution, and outcome
  review for every paper trade. Compare filtered decisions with blind copy,
  watchlist, and skips before changing filters.

## Copyability: the key expansion concept

The best wallet is not necessarily the highest-PnL wallet; it is the one whose
signal leaves the most **remaining executable upside** after its trade. For a
YES-side position, the proposed measurement is:

```text
remainingUpsideCapture = (1 - ourAllInPrice) / (1 - walletVWAP)
```

This is economically better than a fixed-cent entry gap: a 0.60→0.70 move may
leave material upside, while 0.78→0.83 may not. Use an executable all-in quote,
not a stale indicative price.

One Data API fill is not wallet conviction. Aggregate same-wallet BUY fills in a
token over a short interval before comparing notional with normal bet size.
Signal quality can increase when independent profitable wallets agree or when
the original wallet demonstrably scales in; copycat wallets are not independent
consensus.

## Strategy boundaries

Keep materially different payoff mechanisms in separate ledgers and result sets:

1. **Lane A — core sports wallet copy:** viable favorites entered before event
   completion and held to resolution. This is the primary engineering focus.
2. **Lane B — post-final resolution lag:** proven-wallet purchases after a sports
   feed reports final status but before market resolution. Separate strategy and
   evidence from Lane A.
3. **Lane C — adjacent-category shadow copy:** wallet-copy logic in categories
   such as short-duration weather. Paper/shadow only until independently proven.

For Lane A, a price stop-loss can contradict the hold-to-resolution thesis. Use
resolution horizon, market-specific fees, official closed positions or terminal
settlement, and executable quotes to evaluate copyability.

## Research inventory — hypotheses, not approved strategies

Each idea requires isolated, live-paper validation before implementation:

| Idea | Claimed signal / constraint |
|---|---|
| Political underconfidence fade | Politics favorites may be 13–18% underconfident; validate per category. |
| Cross-cycle BTC sandwich | Pair different-duration UP/DOWN cycles ending together if combined cost < $1.00. |
| Calendar arbitrage | A later-date YES should be worth at least an earlier-date YES. |
| Endgame favorites | Near-resolution favorites need liquidity, tight spread, no spike, and book/flow confirmation. |
| Crash mean reversion | >20% crashes may revert in crypto/sports; do not generalize to fundamental categories. |
| BTC dump-and-hedge | Early-cycle dump plus opposite side only when combined cost remains below target. |
| Post-news herd fade | Fade short retail-chasing surges only with a measurable, timely news signal. |
| Five-minute BTC settlement fade | Study final-30-second manipulation separately from cleaner 15-minute contracts. |
| Sports home-field pricing | Test for under-adjustment; do not assume a generic sports edge. |
| Trap detector | Do not chase bearish sentiment below 0.20 or bullish sentiment above 0.80 once priced. |
| Multi-outcome arbitrage | Buy all outcomes only when sum < $1 and non-atomic-fill risk is controlled. |
| Macro news latency | Compare Polymarket with faster external markets around discrete releases. |
| Tournament constraints | Test logical bracket probability identities for violations. |
| PROPHET ensemble | Not appropriate now: needs authenticated data, GPU/ML infrastructure, and breaks the lean mandate. |
| Longshot spread capture | Needs authenticated maker execution/rebates; not a current lane. |

### Retained research conclusions

- Politics may be most distorted; sports and crypto are generally efficient at
  short horizons without a non-market signal.
- Weather and entertainment may show short-horizon overconfidence; they are
  research candidates, not assumed edges.
- Pure LLM forecasting did not show reliable out-of-sample edge in reviewed
  work. Prefer structural, calibration, or microstructure advantages.
- Do not use raw Shin's z as a manipulation detector: bettor disagreement
  confounds it. A reported favorite sweet spot was roughly 0.40–0.60, not 0.93+.

## Sources retained for follow-up

- Le (2026), *Decomposing Crowd Wisdom*, arXiv:2602.19520.
- Saguillo et al. (2025), *Unravelling the Probabilistic Forest*, arXiv:2508.03474.
- Dubach (2026), *Anatomy of a Decentralized Prediction Market*.
- Dai, Jia & Yu (2026), *Settlement Manipulation in Prediction Markets*.
- Torul et al. (2026), *Informational Inertia*; Nguyen et al. (2026), *PROPHET*.
- Cheng, Yang & Zou (2026), *Arbitrage Analysis in NBA Markets*, arXiv:2605.00864.
- Cordoba & Themistocleous (2025), Polymarket election lead-lag study; Whelan
  (2024–25), bettor disagreement and Shin's z.

Supplementary leads: Polyguana, LainNet-42, OrcaLayer, functionSPACE, Poly Syncer,
and the cited developer analyses. Verify every claim with live market data.

## Change-history policy

Do not preserve session summaries or stale roadmaps. Git history and code
comments preserve implementation flow. Before changing a core admission rule,
inspect relevant commits, active configuration, paper-trade results, and tests;
record the rationale in code or the decision journal.
