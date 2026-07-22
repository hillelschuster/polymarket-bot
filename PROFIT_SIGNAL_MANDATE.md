# Profit Signal Mandate

## Sacred Mental Model

This repository exists for one purpose: **generate sustainable net income on Polymarket**.

Every implementation decision must be judged by one question:

> Does this increase long-run realized PnL after spreads, fees, slippage, failed fills, capital lockup, and losses?

The strategy already has a coherent core: discover strong wallets, observe their positions quickly, estimate whether their edge remains copyable at the current executable price, allocate capital intelligently, and exit when the copied thesis or wallet behavior changes.

Do not redesign the bot into a risk-elimination system. Do not add complexity merely because it looks robust. Do not suppress valid opportunities because evidence is incomplete, markets are volatile, or losses are possible. Uncertainty should usually reduce size, not force inactivity.

The goal is not maximum win rate. The goal is maximum payoff-weighted net profit and bankroll growth.

## Non-Negotiable Implementation Rules

1. **Preserve the fundamental wallet-copy strategy.** Improve signal quality, ranking, sizing, execution, and capital recycling; do not replace the strategy.
2. **No hardening for its own sake.** A safeguard must prevent a concrete profit leak, accounting defect, invalid fill, duplicate exposure, or unrecoverable execution error.
3. **No alpha-killing filter inflation.** Do not stack arbitrary thresholds until almost nothing trades.
4. **No consensus requirement.** Independent-wallet agreement can increase conviction and size, but a strong single-wallet signal remains tradeable.
5. **No sample-size paralysis.** Weak evidence means exploratory sizing. It does not automatically mean `PASS`.
6. **No permanent wallet rejection from temporary unrealized PnL.** Resolved copy evidence dominates. Open marks are secondary.
7. **No universal category restriction.** Sports is the current proven core, but wallets may have edge in politics, crypto, esports, or other categories. Judge edge per wallet and category.
8. **No generic stop-loss logic imposed on binary sports markets without payoff evidence.** Follow wallet exits, thesis changes, market validity, and resolution behavior.
9. **No fake profitability.** Use executable CLOB prices, real fee logic, real depth, correct capital accounting, and correct settlement.
10. **No architecture, dashboards, documentation, or abstractions unless they materially improve income.**
11. **No test-driven obstruction.** Verification is limited to mechanical correctness of accounting, deduplication, sizing, quotes, fills, exits, and settlement. Tests do not become admission gates and do not delay profitable behavior.
12. **Prefer simple profit logic.** Fewer coherent rules are better than many weak rules.

## Core Profit Objective

The upgraded bot must:

1. Observe more potentially profitable wallets and categories.
2. Detect their meaningful trades faster and without missing fills.
3. Distinguish initial entry, scale-in, consensus, reduction, and exit behavior.
4. Estimate whether the edge remains after current executable price, spread, fees, depth, and delay.
5. Rank all fresh opportunities against each other.
6. Allocate more capital to stronger expected-value opportunities.
7. Keep smaller exploratory bets alive where evidence is promising but incomplete.
8. Stop wasting capital on wallet-category combinations that are materially proven unprofitable.
9. Exit positions using wallet behavior and market reality rather than crude universal rules.
10. Measure realized and mark-to-market performance accurately enough to improve capital allocation.

# Phase 1 — Atomic Signal and ROI Upgrade

## A. Signal Capture

- [ ] Poll eligible wallets with bounded concurrency instead of fully sequential calls.
- [ ] Preserve rate-limit discipline without adding unnecessary latency.
- [ ] Add per-wallet time watermarks so every new trade since the last successful scan is captured.
- [ ] Paginate when required; do not assume the latest 20 trades contain every unseen fill.
- [ ] Replace transaction-hash-only deduplication with a deterministic fill identity using transaction, token, side, price, size, and timestamp.
- [ ] Cache market metadata across wallets and candidates during a loop.
- [ ] Keep strong wallets on the fastest polling path.
- [ ] Keep exploratory wallets observable at lower frequency instead of permanently ignoring them too early.

## B. Wallet and Category Intelligence

- [ ] Separate public wallet history from our own copy results.
- [ ] Restrict internal copy-performance calculations to `source = wallet_copy`.
- [ ] Give resolved copy PnL, ROI, and decisive win rate the highest weight.
- [ ] Treat open unrealized PnL as a weak temporary signal only.
- [ ] Calculate performance per wallet and per wallet-category where enough information exists.
- [ ] Preserve a global wallet score as a secondary prior, not the sole decision mechanism.
- [ ] Use four practical states:
  - **A:** internally proven strong; full-size eligible.
  - **B:** credible public record or early internal support; normal-size eligible.
  - **C:** promising but uncertain; exploratory-size eligible.
  - **DROP:** materially negative resolved evidence; no new allocation until evidence changes.
- [ ] Avoid permanent `ignore` status based only on temporary open losses.

## C. Candidate Construction

- [ ] Convert raw fills into meaningful wallet campaigns.
- [ ] Aggregate tiny same-wallet fills that represent one order or scale-in sequence.
- [ ] Identify initial BUY entries.
- [ ] Identify material same-wallet scale-ins.
- [ ] Identify independent-wallet confirmation on the same token.
- [ ] Identify wallet SELL reductions and exits for tokens the bot holds.
- [ ] Never treat SELL as a naked-short signal.
- [ ] Prevent duplicate exposure without suppressing legitimate scale-ins or consensus.

## D. Remaining-Edge Calculation

For each fresh candidate, calculate a compact expected-value score using:

- [ ] Wallet resolved-copy evidence.
- [ ] Wallet-category evidence.
- [ ] Public wallet evidence.
- [ ] Current executable all-in buy price.
- [ ] Difference from the wallet fill price.
- [ ] Signal delay as a decay input, not an automatic rejection by itself.
- [ ] Current spread.
- [ ] Available depth for the intended size.
- [ ] Fee amount and fee-adjusted payout.
- [ ] Favorite/underdog structure.
- [ ] Independent-wallet consensus.
- [ ] Same-wallet scale-in conviction.
- [ ] Estimated capital lock duration.
- [ ] Existing correlated exposure.

Reject only when the executable economics are negative, invalid, duplicated, or materially worse than available alternatives.

## E. Candidate Capital Auction

- [ ] Gather all fresh candidates before committing the loop's bankroll.
- [ ] Rank candidates by expected net value, not arrival order alone.
- [ ] Allocate capital from strongest to weakest while positive expected value remains.
- [ ] Use approximate starting bankroll sizing:
  - Tier C exploratory: 2–3%.
  - Tier B normal: 4–5%.
  - Tier A strong: 6–8%.
  - Consensus or meaningful scale-in: increase within a 10% event cap.
- [ ] Keep total deployed capital around 60–70% by default so later opportunities remain fundable.
- [ ] Keep highly correlated slate exposure around 20–25% unless the candidate set clearly justifies more.
- [ ] Scale sizes with current bankroll so profitable capital compounds.
- [ ] Do not use these limits to reject positive-EV trades automatically; reduce or prioritize size when capital is constrained.

## F. Sports and Category Timing

- [ ] Preserve actual event start/end timing.
- [ ] Distinguish pregame, live, finished, delayed, canceled, postponed, and invalid markets.
- [ ] Use Sports WebSocket status when available and Gamma metadata as supporting evidence.
- [ ] Do not apply generic multi-day non-sports timing rules to valid in-game sports opportunities.
- [ ] Expand beyond sports only when a wallet-category combination has coherent evidence and executable economics.
- [ ] Begin unproven categories with exploratory sizing rather than blocking them completely.

## G. Exit and Capital Recycling

- [ ] Record and react to wallet SELL activity on positions the bot holds.
- [ ] Support partial reductions when the source wallet partially exits.
- [ ] Support full exit when the source wallet materially closes.
- [ ] Allow strong independent-wallet support to offset one weak reduction only when net evidence remains positive.
- [ ] Exit canceled, invalid, or structurally broken markets.
- [ ] Remove the crude universal sports stop-loss as the primary exit mechanism.
- [ ] Keep an emergency mechanical exit only for demonstrable invalid-exposure cases, not ordinary sports volatility.
- [ ] Recycle released capital immediately into the next highest-ranked positive-EV candidate.

## H. Execution Quality

- [ ] Preserve fail-closed executable CLOB quoting: no executable quote means no pretend fill.
- [ ] Prefer maker-first when spread, urgency, and expected edge allow.
- [ ] Use short-lived post-only/GTD orders for patient entries.
- [ ] Fall back to immediate FOK/FAK execution only while expected net value remains positive.
- [ ] Cancel stale resting orders.
- [ ] Record partial fills, rejected orders, actual fill price, actual fees, and missed opportunities.
- [ ] Size from executable depth, not nominal midpoint liquidity.
- [ ] Keep wallet-copy real execution disabled until explicitly activated with credentials and a real-money switch.

## I. Performance Isolation and Learning

- [ ] Keep wallet-copy results separate from calendar arbitrage, politics, Lane B, and other strategy lanes.
- [ ] Track PnL and capital use by wallet, category, signal type, and execution style.
- [ ] Compare single-wallet entries, scale-ins, and consensus trades.
- [ ] Measure net ROI on deployed capital, bankroll ROI, capital lock time, and realized PnL.
- [ ] Promote evidence that improves payoff-weighted profit.
- [ ] Demote or remove rules that reduce net PnL without compensating benefit.
- [ ] Do not automatically mutate live thresholds from noisy samples.

# Phase 2 — General Profit Expansion

After Phase 1 produces trustworthy live/paper evidence:

- Expand wallet discovery beyond leaderboard rank using category specialists, repeat winners, and copyable execution behavior.
- Improve capital rotation between categories and strategy lanes according to realized return per day of capital lock.
- Add direct opportunity discovery where the wallet signal and structural market signal agree.
- Scale bankroll exposure as validated edges persist.
- Use Lane B terminal opportunities only after the shadow log shows positive net economics.
- Activate real wallet-copy execution through a small, measurable pilot and scale from realized evidence.

# Decision Rule for Every Future Change

Before implementation, answer:

1. What exact profit leak or missed opportunity does this fix?
2. How can it increase realized PnL, improve fills, improve sizing, or accelerate capital recycling?
3. Could it suppress an existing profitable signal?
4. Can the same benefit be achieved with less complexity?
5. Does it preserve exploratory bets under uncertainty?
6. Does it use real executable economics rather than cosmetic metrics?

If a change cannot answer these questions clearly, do not add it.

## Sacred Final Goal

This repository exists for one purpose: **generate sustainable net income on Polymarket**.

Do not optimize for safety theater, test count, architectural elegance, dashboards, academic certainty, or high win rate in isolation. Do not assume uncertainty invalidates an edge. Do not add layers whose primary result is fewer trades.

Improve the mechanism that discovers, ranks, sizes, executes, and exits profitable opportunities. Preserve coherent risk-taking. Allocate small capital to promising uncertainty, larger capital to proven advantage, and no capital to materially negative expected value.

The final measure is **long-run realized net PnL and compounded bankroll growth**. Nothing else outranks it.
