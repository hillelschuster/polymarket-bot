# Verdict

**Yes—there is enough evidence to justify a separate profit-amplification bot.**

**No—84% alone does not justify external leverage or blindly multiplying every position.**

The correct opportunity is:

> Preserve the existing bot unchanged. Build a second, isolated overlay that identifies which accepted signals have measurable edge **over their executable entry price**, then selectively sizes larger, pyramids on confirmation, and potentially exits earlier to recycle capital.

The code audit is complete. Exact empirical attribution requires your local SQLite database; I cannot inspect its actual 50 trades from GitHub.

## What the 84% means

**Source—user:** approximately 84% resolved win rate over almost 50 trades and eight days.

The dashboard genuinely calculates win rate from **resolved trades only**. It is not counting temporarily profitable open positions.

Assuming the sample is exactly **42 wins from 50 trades**, the approximate 95% Wilson interval is:

> **71.5%–91.7% terminal win probability**

That is strong preliminary evidence. But the relevant baseline is not 50%. The bot buys favorites, generally requiring executable prices above 0.55–0.65 and below 0.80.

For a token bought at all-in price `c`, break-even probability is `c`:

[
Expected\ ROI = \frac{p}{c}-1
]

Illustration using `p = 84%` and the conservative 71.5% lower confidence bound:

| All-in entry | Point-estimate ROI | ROI at 71.5% bound | Conservative ¼-Kelly |
| -----------: | -----------------: | -----------------: | -------------------: |
|         0.65 |             +29.2% |             +10.0% |        4.6% bankroll |
|         0.70 |             +20.0% |              +2.1% |        1.2% bankroll |
|         0.75 |             +12.0% |              −4.7% |                   0% |
|         0.80 |              +5.0% |             −10.6% |                   0% |

**Conclusion:** if average all-in entry is near 0.65–0.70, the result is potentially exceptional. If it is near 0.78–0.80, the win rate looks impressive but is not yet statistically sufficient to prove substantial edge.

## What the bot does well

The paper execution is materially realistic:

* It walks actual CLOB asks for the requested cash size.
* It includes token-specific fees.
* It rejects insufficient depth instead of inventing a midpoint fill.
* Open positions are marked using executable sell-side depth.
* The live path re-quotes and rejects the order if the fresh book exceeds the approved cost.

The settlement PnL formula is correct: cash is converted into shares, then shares are valued at zero or one.

A paper snapshot can still overstate **fill rate** because the book can move before an actual FOK order reaches it. It should not materially distort the binary outcome selection itself at $5–$20 sizes, but that must ultimately be measured from `LiveOrder` filled versus `not_filled`.

## Serious audit findings

### 1. The 50 trades are not one stable strategy

The repository changed substantially during the eight-day period:

* Signal timing and wallet-quality gates changed.
* Sports resolution handling changed.
* Stop-loss behavior changed.
* The leaderboard parameter bug was fixed only on **July 29, 2026**; before that, API parameters silently fell back to the daily leaderboard, changing wallet discovery.
* Multi-horizon discovery and category enrichment were also introduced late in the sample.

Therefore, 84% is the result of a **mixture of bot versions**. It proves that the evolving family of mechanisms found something; it does not yet tell us which current mechanism owns the edge.

Every trade must be segmented by `openedAt`, `logic=vX`, and active rule version before sizing conclusions.

### 2. Resolution-speed bias

The dashboard includes only completed trades. Sports positions can resolve within hours, while longer political and general markets remain open. The bot explicitly gives sports separate same-day timing treatment, whereas non-sports generally require at least three days to resolution.

Thus the current 84% is probably dominated by short-duration sports. It is not yet the eventual win rate of every position the bot initiated.

This is not necessarily bad. It may indicate that **short-duration wallet-copy favorites are the actual high-velocity edge**. But the distinction matters.

### 3. Open PnL contaminates future wallet selection

`scoreTrades.ts` builds wallet copy performance using **all paper trades**. Open trades contribute unrealized PnL and are counted as wins whenever currently positive. That affects wallet rejection, catastrophic-loss stopping, and position confidence.

This directly contradicts the stated design elsewhere that wallet demotion should use resolved/closed outcomes only.

This does not invalidate the resolved 84%. But it means the strategy is partly adapting to short-term mark-to-market momentum, whether intended or not. That hidden momentum filter may itself be profitable—or may be unstable. It must be isolated.

### 4. The feature backtest has incorrect PnL

The research script calculates:

```text
(finalPrice - entryPrice) × cash position size
```

But correct prediction-market PnL is:

```text
(cash position size / entryPrice) × (finalPrice - entryPrice)
```

The script therefore records each trade’s true PnL multiplied by its entry price.

Consequences:

* Existing claims that particular entry-price or liquidity buckets produced specific dollar profits are unreliable.
* The favorite-gate rationale may still be directionally correct, but its reported `+$7.81` versus negative blind-copy result must be recomputed.
* The current script’s supposed wallet-side “out-of-sample” feature also uses other trades from the future and removes trades by equal PnL value rather than by trade identity. It is neither chronological nor truly out-of-sample.

External research supports conditioning calibration on category and time-to-expiry, not applying one universal favorite rule. The large 2026 Kalshi/Polymarket study found structured category-specific calibration and political underconfidence; recent sports research found calibration changes sharply near expiry. ([arXiv][1])

### 5. There is no real counterfactual dataset

The performance page is designed to compare accepted trades with watchlisted and skipped candidates.

But the production outcome-review job only reviews actual open `PaperTrade` records. It does not shadow-price and resolve every rejected signal.

Therefore, the database currently cannot answer:

* Did wallet selection create the edge?
* Did the favorite gate create it?
* Did freshness create it?
* Would blind copying have made more money despite lower win rate?
* Which rejected trades were profitable?

This is the largest obstacle to understanding the mechanism.

### 6. Current sizing is not economically grounded

Positions are $5–$20. Confidence is derived from the market score, or replaced with:

```text
0.6 + average wallet PnL × 3
```

That average PnL:

* Is measured in dollars, not ROI.
* Depends on prior position sizes.
* Includes open PnL.
* Saturates extremely quickly.
* Does not compare estimated probability with entry price.

The selection engine may have edge. The sizing engine is not yet exploiting it.

## My best hypothesis for the edge

Ranked by current conviction:

### 1. Wallet information plus a strong market prior

The market price already identifies favorites. Skilled-wallet activity supplies an additional likelihood update. The economically correct question is not “does this cell win 84%?” but:

> How much does a wallet signal increase true probability above the executable market price?

This should be modeled as:

[
\operatorname{logit}(P(\text{win})) =
\operatorname{logit}(\text{all-in price}) + \alpha
]

Then estimate separate, shrunk `α` values for category, wallet tier, timing, and confirmation type.

### 2. Fresh, non-adverse entries

The bot rejects stale signals, large entry gaps, adverse movement, excessive spreads and toxic volume. Those mechanisms plausibly remove wallet trades whose informational content has already decayed.

### 3. A hidden scale-in effect

Unscored trades are processed newest-first, and once a market/token is copied, all other fills are deduplicated.

When several fills arrive together, the bot may effectively select the wallet’s **latest fill**, potentially after the wallet has already demonstrated continued conviction. This is not campaign aggregation, but it may accidentally approximate it.

### 4. Short-duration sports capital velocity

The edge may not be universal wallet-copy alpha. It may specifically be:

> Recent profitable wallets buying liquid sports favorites shortly before resolution, with enough time left to copy but little uncertainty left.

That is a much narrower and potentially much more profitable thesis.

## The separate bot I would build

Call it the **Edge Amplifier**. It reads the original SQLite database but writes to a separate database and uses separate capital. The original bot remains untouched.

### Lane 1: Posterior sizing

For every accepted signal, estimate a conservative probability `p_floor`, not merely the historical win rate.

[
f = 0.25 \times \max\left(0,\frac{p_{floor}-c}{1-c}\right)
]

Where:

* `c` = current executable all-in price.
* `p_floor` = conservative posterior probability after shrinkage.
* `f` = fraction of bankroll risked.

Initial sizing recommendation:

* Positive posterior mean but uncertain edge: **0.25% exploratory position**.
* Statistically supported edge: quarter-Kelly.
* Temporary cap: **2% per trade, 6% per event cluster**.
* Recalculate caps after the database reveals actual drawdowns and correlation.

Fractional or uncertainty-adjusted Kelly is appropriate because probability estimation error materially damages long-run growth; this is a known limitation of naive full Kelly. ([arXiv][2])

### Lane 2: Confirmation pyramiding

Add to an existing position when:

* The source wallet scales in again.
* A genuinely independent profitable wallet buys the same token.
* The wallet’s total position increases materially relative to its normal size.
* The new all-in entry remains below conservative fair value.
* Event-cluster exposure remains acceptable.

Current dedup prevents this. A separate amplifier can treat the original entry as tranche one and confirmations as additional tranches.

This may be the cleanest form of “leverage”: more capital only after additional information arrives.

### Lane 3: Loss-avoidance overlay

There are only approximately eight losers. Do not train a large classifier.

Use leave-one-day-out testing and allow at most one or two filters. Test whether losers concentrate in:

* Entry-price band.
* Signal delay.
* Wallet-to-copy price gap.
* Single fill versus scale-in.
* Wallet bet size relative to its median.
* Category and league.
* Resolution horizon.
* Event-level concentration.
* Independent consensus versus apparent copycat consensus.
* Wallet’s subsequent reduction or exit.

Optimize **net PnL and PnL per capital-day**, not win rate.

### Lane 4: Source-wallet exit intelligence

The opening engine correctly rejects `SELL` as a new short trade. But a subsequent SELL by the wallet that originated an existing copied BUY is valuable position-management information.

The amplifier should detect:

* Source wallet reducing the copied token.
* Source wallet closing completely.
* Source wallet buying the opposite outcome.
* Multiple trusted wallets reversing.

That may remove some of the 16% failures without imposing a generic price stop-loss.

### Lane 5: Capital-velocity exits

The database already records executable sell quotes approximately every fast cycle.

Replay:

* Hold to resolution.
* Exit at 0.85, 0.90 or 0.95.
* Exit after a fixed time.
* Exit when expected remaining profit per capital-day falls below the next available trade.
* Exit when the source wallet exits.

A slightly lower profit per winning trade can generate higher annualized PnL if capital is recycled much faster.

### Lane 6: Maker-first execution experiment

Polymarket’s current fee structure charges takers in many categories, while makers pay no trading fee and may receive rebates. ([Polymarket Documentation][3])

For the strongest, slower-decaying signals:

1. Place a short-lived maker order near the bid or inside the spread.
2. Cancel quickly if unfilled.
3. Use FOK only while the remaining edge still exceeds the extra cost.

This must be shadow-compared against immediate FOK because delay may destroy wallet-copy alpha.

## Do not use external leverage yet

Official Polymarket mechanics are fully collateralized: every Yes/No pair is backed by one dollar of collateral. I found no native margin mechanism in the documented trading model. ([Polymarket Documentation][4])

Borrowing USDC externally would amplify an edge, but it would also amplify:

* Strategy-version uncertainty.
* Correlated sports outcomes.
* Resolution and fill risk.
* A potentially unrepresentative eight-day sample.

That is inferior to **information-conditioned sizing and faster capital turnover** at this stage.

## Highest-EV next analysis

The local SQLite file is decisive. The default configuration points to a SQLite `dev.db`; depending on Prisma resolution and your environment, it is commonly under `prisma/dev.db`, but `DATABASE_URL` is authoritative.

With that database, the exact investigation should produce:

1. Correct realized PnL, ROI and calibration gap by all-in price.
2. Results segmented by code version and date.
3. Effective sample size after event/wallet/day clustering.
4. Winner-versus-loser feature attribution.
5. Chronological, leakage-free wallet analysis.
6. Scale-in and independent-consensus effects.
7. Optimal posterior-Kelly sizes.
8. Early-exit and capital-turnover replay.
9. Actual live-fill parity where `LiveOrder` records exist.
10. A concrete Edge Amplifier specification based on observed numbers rather than assumptions.

**Bottom line:** the 84% should not be dismissed. There is probably real alpha. But the most profitable interpretation is not “this bot predicts events at 84%.” It is likely “a narrow combination of market probability, wallet information, freshness, and short resolution produces a repeatable probability uplift.” Extract that uplift, size it intelligently, and compound it through confirmations and capital velocity.

[1]: https://arxiv.org/abs/2602.19520?utm_source=chatgpt.com "Decomposing Crowd Wisdom: Domain-Specific Calibration Dynamics in Prediction Markets"
[2]: https://arxiv.org/abs/2412.14144?utm_source=chatgpt.com "Application of the Kelly Criterion to Prediction Markets"
[3]: https://docs.polymarket.com/trading/fees?utm_source=chatgpt.com "Fees - Polymarket Documentation"
[4]: https://docs.polymarket.com/concepts/positions-tokens?utm_source=chatgpt.com "Positions & Tokens - Polymarket Documentation"
