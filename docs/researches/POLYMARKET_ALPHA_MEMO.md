# Polymarket Alpha Memo — Evidence-First, Small-Capital Edition

**Date:** 2026-07-29

**Scope:** new research directions for a $100–200 starting bankroll. This is not a recommendation to trade any market.
**Standard:** a trade only exists if its *current executable* CLOB fills, fees, leg risk, and resolution rules leave positive locked or measured expected value.

## Executive decision

The current wallet-copy engine has the right operating philosophy but not enough evidence to declare its own favorite filter proven. Its only positive local comparison is **+$7.81 across 45 resolved filtered copies versus -$21.42 blind**; the code explicitly flags that as a small, potentially overfit sample. The direct sports-favorites replay is worse: **24 fills from 251 markets, -14.5% ROI, 95% CI [-39.6%, +8.5%], `INCONCLUSIVE_SAMPLE`**. That makes “more favorite betting” an unacceptable new-alpha proposal.

The strongest fresh direction is instead **fee-adjusted structural baskets**: complete NegRisk outcome bundles and a small, curated set of strict logical-implication pairs. These do not require predicting the world; they require paying less than a guaranteed payout, using actual fillable depth. The academic evidence says such mispricings have been extracted historically, but it also says capacity is shallow. Therefore the first deliverable is a passive, executable-book measurement—not a live trading feature.

Everything else in this memo is ranked below that core because its present-day net PnL is unmeasured, episodic, or both. No percentage-return forecast below is invented where the evidence does not support one.

---

## 1. What the existing engine gets right

### The reusable standard

The engine should be the bar for every new lane:

1. **Entry is executable, not displayed.** `src/jobs/scoreTrades.ts:312-385` requires a fresh CLOB buy quote and re-runs the market gates on that quote. It does not admit a midpoint fallback.
2. **Open PnL is executable.** `src/jobs/paperUpdatePnl.ts:7-88` marks an open paper position using an executable sell quote, not Gamma/UI prices.
3. **Resolution is terminal.** `src/jobs/reviewOutcomes.ts:9-139` resolves only when Gamma shows a closed market and terminal outcome prices.
4. **Live submission fails closed.** `src/lib/liveExecution.ts:12-97` persists intent, blocks after an unknown order, caps total exposure, and uses FOK execution.
5. **There is already a basket precedent.** Calendar arbitrage has quote, FOK-basket, and exact-share unwind logic in `src/jobs/scanCalendarArbitrage.ts` and `src/adapters/execution.ts:330-405`.

This is a much better starting point than an elegant historical backtest. A candidate must survive:

```text
signal -> executable book -> fee model -> fill sequencing -> inventory state
       -> exit/resolution mechanics -> realized cash PnL
```

### What is explicitly not new

Do not spend a new lane on the following:

| Existing lane or claim | Local status | Why it is excluded |
|---|---|---|
| Calendar/deadline arbitrage | Live paper scanner | `src/lib/calendarArbitrage.ts`, `src/jobs/scanCalendarArbitrage.ts` already implement it. |
| Political favorites | Live paper scanner | `src/jobs/scanPoliticalFavorites.ts` already applies the 1.31 logit calibration slope. |
| Favorite–longshot / sports favorites | Core selector / inconclusive direct test | The production filter is based on only 45 resolved copies; the direct sports replay is negative and inconclusive. |
| Generic wallet mining | Research only, API assumptions weak | Public arbitrary-wallet historical availability is not guaranteed by the official API docs. |
| Generic crash reversion | Hypothesis only | No retained primary evidence establishes net executable Polymarket PnL. |
| Resolution “sweeping” | Latency race | A resolution delay alone is not an edge; queue priority, stale information, and dispute risk dominate. |
| Maker rebates | Execution subsidy, not alpha | A rebate cannot compensate for adverse selection or an unproven signal. |

---

## 2. Non-negotiable arithmetic

### Prices displayed by the UI are not prices a strategy can trade

Polymarket documents that its displayed price is the bid–ask midpoint; with a spread wider than $0.10, it displays the last traded price instead. Neither is a fill guarantee. The only valid input to an entry decision is depth walked from the actual CLOB book.

For `q` shares, calculate separately for every leg:

```text
cashCost(q) = q × executable VWAP ask(q) + takerFee(q)
cashProceeds(q) = q × executable VWAP bid(q) - takerFee(q)
```

The published taker-fee formula is:

```text
fee = C × feeRate × p × (1 - p)
```

where `C` is shares and `p` is the trade price. Makers have a zero maker fee, but a resting order still has queue and adverse-selection risk. At 50¢, the currently published **crypto** taker fee is $1.75 on a 100-share/$50 trade—**3.5% of trade value per side** before spread. A two-sided taker round trip near 50¢ starts roughly 7% behind before price movement. That fact alone rejects most short-horizon crypto ideas for a small, non-maker bot.

### Every structural basket must have an explicit payoff table

For a full mutually exclusive outcome bundle with one share of each YES token:

```text
lockedPayout(q) = q
lockedGross(q)  = q - Σ cashCost_i(q)
```

The trade is admissible only if all legs are fillable at the same target size and `lockedGross` still exceeds a deliberate operational reserve for failed-leg unwinds, ticks, conversion, and on-chain costs. The first experiment should record reserve-free and reserve-adjusted values separately rather than pretending one fills atomically.

For a strict implication `A ⇒ B`, the pair **YES(B) + NO(A)** pays at least $1 in every valid state:

| World state | YES(B) | NO(A) | Total |
|---|---:|---:|---:|
| A true (therefore B true) | 1 | 0 | 1 |
| A false, B true | 1 | 1 | 2 |
| B false (therefore A false) | 0 | 1 | 1 |

It is a lock only when the claims have identical, carefully checked resolution semantics and the all-in pair cost is below $1. A title-level resemblance is never enough.

---

## 3. Ranked fresh research directions

**Ranking method:** expected *durable* edge × feasibility at $100–200, discounted for source quality, fill risk, and time-to-proof. “Unknown” means the source establishes a mechanism but does not establish the strategy’s net current PnL.

| Rank | Direction | Current evidence | Capital/infra fit | Deployment verdict |
|---:|---|---|---|---|
| 1 | NegRisk full-bundle / binary-underround rebalancing | Strong structural evidence | Excellent at retail depth; needs disciplined baskets | Measure now; paper trade only after observed fillability |
| 2 | Curated strict-implication / threshold-ladder baskets | Strong theory, medium empirical support | Excellent; manual templates avoid NLP | Measure alongside #1 |
| 3 | Macro-release latency measurement | One persuasive historical episode, no current replication | Very cheap passive monitor | Observe first; no trade claim yet |
| 4 | Resolution-rule / clarification watchlist | Rules mechanism is real; repeatable return is unproven | Manual, low frequency | Discretionary research queue only |
| 5 | Five-minute BTC post-settlement distortion monitor | Underlying distortion documented; token PnL not shown | Retail-scale but fee/latency hostile | Observe only; do not deploy taker capital |
| 6 | Display-price versus executable-book divergence | Documentation proves the measurement problem, not a return | Useful everywhere | Execution-quality overlay, not a standalone strategy |

### 3.1 Rank #1 — NegRisk full-bundle and binary-underround rebalancing

**Thesis.** In an exhaustive, mutually exclusive event, one YES outcome must ultimately pay $1 and all others $0. When separate books let a complete, *fillable* YES bundle cost less than $1 after fees, the payout is locked without forecasting. For an ordinary binary market, the same principle applies to a fillable YES + NO pair.

**Who loses.** Traders price and transact in one outcome at a time; stale resting liquidity and fragmented demand leave the complementary probability space temporarily inconsistent. The counterparty is not “the market” in the abstract—it is the collection of independently priced legs and any liquidity provider willing to sell them at a combined underround.

**Why the evidence is strong.**

* Saguillo, Ghafouri, Kiffer, and Suarez-Tangil studied Polymarket from April 1, 2024 to April 1, 2025. Their AFT 2025 paper formalizes intra-market rebalancing and inter-market combinatorial arbitrage and reports a **realized estimate of $40m extracted across both** during that measurement period. This establishes that the identities were historically breached and executed; it does **not** provide a universal per-basket ROI.
* Polymarket’s NegRisk documentation states that a NO share in one outcome can be converted through the Neg Risk Adapter into one YES share in every other outcome. That can make some all-but-one constructions operationally cheaper, but conversion must be tested as an on-chain workflow before it is used in an execution path.
* Cheng, Yang, and Zou’s NBA-book study provides the necessary restraint: combinatorial executions had a **101 bps median return**, but 76.9% were constrained to only **14.8 shares** on average. The result supports retail-scale detection, not scalable passive income.

**Simple capture method.**

1. Enumerate active Gamma events flagged `negRisk`; separately enumerate binary condition pairs.
2. Pull a synchronized CLOB book for every leg. Never sum `bestAsk`, midpoint, or last-trade values.
3. For each target size `q` in a small ladder—e.g. 5, 10, 15 shares—walk book depth, apply the actual category fee, and calculate complete-basket cash cost.
4. Log a candidate only if every leg supports `q`, the reserve-adjusted locked gross is positive, and the event’s resolution structure is exhaustive today.
5. Initially restrict executable trades to a full YES bundle or a standard binary YES+NO underround. Do **not** trade the direction requiring short inventory, issuance, or an untested conversion path.
6. If eventually paper-entering, submit size-capped FOK legs and treat any filled first leg as inventory requiring immediate exact-share unwind—not as a near-miss success.

**Honest economics.** Conditional on complete fills and valid exhaustive rules, a true underround has a **100% terminal payoff win rate** because it is an identity. That is not the strategy win rate: partial fills, broken event schemas, “Other” outcomes, conversion mistakes, disputes, and unwind slippage create real losses. Current expected ROI is **not locally measured**. The defensible numerical anchors are the historical $40m aggregate extraction and the NBA study’s 101 bps median combinatorial execution, with very shallow capacity.

**Decay and failure modes.**

* Professional scanners may remove the best underrounds quickly.
* A REST snapshot can be stale by the time leg two is submitted.
* New outcomes or a catch-all can invalidate a naïvely assumed fixed outcome set.
* Conversion and redemption are operational steps, not algebra.
* A positive theoretical gap can be smaller than the leg-unwind loss.

**Fastest kill experiment.** Run a **7–14 day passive scanner** that records only the exact depth-supported, fee-adjusted basket cost and how long it remains viable. Kill the immediate execution idea if it sees no candidate with all of:

* at least $10 fillable basket notional,
* reserve-adjusted locked gross above one tick plus modeled unwind cost, and
* a surviving window long enough to obtain all book snapshots and send FOK legs.

Only then paper-place a deliberately tiny sample and report completed baskets, one-leg fills, unwind loss, and terminal payout separately.

### 3.2 Rank #2 — Curated strict implications and threshold ladders

**Thesis.** Separate markets can violate a hard logical relation even if each individual book has no binary underround. A threshold ladder is the cleanest example: with identical measurement source and deadline, `X > 100k ⇒ X > 90k`. Buying YES(90k) and NO(100k) locks at least $1 when its all-in cost is below $1.

**Who loses.** Participants treating related questions as separate bets, and stale quotes on a slower leg. The edge is cross-book cognition rather than a belief about Bitcoin, a candidate, or a team.

**Evidence.** Saguillo et al. explicitly distinguish combinatorial arbitrage across dependent conditions from within-condition rebalancing. Cheng et al. demonstrate that executable combinatorial rather than single-market opportunities can exist after depth constraints. Neither source establishes that broad semantic matching is easy or that any particular non-calendar domain is under-botted.

**Simple capture method.** Start with **manual templates only**, each approved by a written payoff table and identical resolution source:

* same instrument, cutoff, source, and deadline: numeric threshold ladders;
* mutually exclusive count partitions whose aggregate is exhaustive;
* exact category nesting where the rule text—not a title or common sense—creates implication.

Explicitly exclude:

* date ladders already handled by the calendar strategy;
* vague political causality such as state win versus presidency;
* sports relations unless every cancellation, overtime, aggregate-score, and source rule makes the implication literal;
* NLP-derived “similarity.” Similar wording is not a financial identity.

**Honest economics.** A validated pair that fills below $1 has a conditional 100% terminal lock, with gross return exactly `(1 - allInCost) / allInCost`. Its opportunity frequency, completed-fill rate, and local ROI are unknown. The 101 bps NBA result is a useful *scale reference*, not a forecast for these templates.

**Decay and failure modes.** The dominant risk is semantic false positive, not model error. Rule text can differ by time zone, source, cutoff inclusive/exclusive wording, void treatment, or event definition. Multi-leg race risk remains even after the logic is right.

**Fastest kill experiment.** Hand-curate **20 unambiguous templates**, stream or snapshot their full books for 14 days, and audit every apparent violation. Kill the lane if it produces zero fee-clearing, depth-supported pairs with at least $10 target notional and 100 bps of pre-reserve locked gross. This threshold is a practical hurdle, not a claim from the literature.

### 3.3 Rank #3 — Macro-release latency: passive replication before trade

**Thesis.** A scheduled primary release may move an external benchmark before the relevant Polymarket book reprices. The potential loser is a slow re-pricer or retail participant reacting to the Polymarket chart rather than the official release and faster benchmark.

**Evidence—and its hard limit.** Aktuğ and Torul document one unusually clean May 15, 2024 CPI-leak case: the BLS report was publicly available 30 minutes early; CME Fed-funds futures moved within seconds; Polymarket Fed-rate books showed near-zero top-of-book response until 08:35. The authors separate the first 30 minutes—potentially inside a 1–2 percentage-point no-arbitrage band—from a five-minute post-release delay not explained by that band. They expressly describe the observation as a **pre-growth baseline** and note that liquidity and algorithmic participation subsequently grew. This is compelling evidence for a low-cost measurement project, not evidence that a 2026 taker trade is profitable.

**Simple capture method.** For CPI, NFP, FOMC, unemployment, and GDP releases:

1. Select only Polymarket contracts with a direct, stated dependency on the release.
2. Begin CLOB WebSocket/book capture at T−5 minutes and retain one-second snapshots through T+30.
3. Record the official release timestamp and a faster external benchmark timestamp/price change.
4. Calculate the first **executable** Polymarket repricing that exceeds fee plus spread—not the first midpoint move.
5. Preserve enough raw depth to simulate a $5–20 FOK buy and a subsequent executable exit.

**Honest economics.** Current ROI and win rate are **unknown**. A 35-minute historical observation cannot be converted into a 1–5% return estimate, especially after fees. A finance-category 50¢ taker fill has a significant published fee, and a thin release-time book can be worse than the visible spread.

**Decay and failure modes.** This is one of the fastest-decaying classes: public calendars concentrate bots; external benchmark mapping can be wrong; and the initial reaction can fall inside a rational bid–ask band. The source event itself involved an accidental early upload, not an ordinary release.

**Fastest kill experiment.** Observe at least **eight major releases**. Do not paper trade unless the median first fee-clearing Polymarket adjustment is more than **60 seconds after** the external benchmark and the reconstructed $5–20 executable outcome remains positive after entry and exit costs. Otherwise kill it.

### 3.4 Rank #4 — Resolution-rule and clarification watchlist

**Thesis.** Markets settle on their written resolution criteria, sources, dates, and subsequent official clarification—not the mental shorthand in a headline. The potential loser is a headline trader who prices “what probably happened” without pricing the claim that will actually pay.

**Evidence and limit.** Polymarket’s resolution documentation confirms rule-driven settlement, a normal proposal/challenge process, and the possibility of additional context in unusual circumstances. That proves a mechanism for price disagreement and delay. It does **not** prove a repeatable, automated return series, so this must remain a low-frequency analyst queue rather than a bot claim.

**Simple capture method.** Maintain a small manual blotter of high-volume open markets with one or more of:

* a named primary source or narrow source hierarchy;
* a hard cutoff where “by,” “on,” publication time, or time zone changes payout;
* a metric definition that differs from the headline convention;
* a formal clarification or UMA-status change.

For every candidate, write the payoff interpretation *before* looking at the price and record links/screenshots to the rule source. Trade only when the rule-supported interpretation creates a material executable divergence, not merely because the wording feels ambiguous.

**Honest economics.** Expected ROI and win rate are unknown. Treat this like concentrated discretionary underwriting: potentially large individual payoffs, potentially zero frequency, and real risk that governance or clarification defeats the interpretation.

**Decay and failure modes.** Ambiguity can mean genuine uncertainty, not a free option. Capital may remain locked through a challenge or dispute; rules can be clarified; and a human can overfit a narrative to text.

**Fastest kill experiment.** Over 30 days, manually audit **50 open, high-volume markets**. Pre-label title/rule divergences and later score whether there was a clear source cue and a greater-than-5pp *executable* divergence. Abandon automation if the audit finds no repeatable cue or if the outcomes depend mainly on subjective governance interpretation.

### 3.5 Rank #5 — Five-minute BTC settlement distortion: observation, not a direct trade

**Thesis.** A short-horizon binary contract that settles on a tradable reference can create incentives to push the underlying near settlement; the final underlying move may then reverse. The likely loser is a prediction-market liquidity trader buying the terminal push as information.

**Evidence—and its hard limit.** Dai, Jia, and Yu’s June 2026 paper studies approximately 16,000 five-minute BTC contracts after launch. It reports a settlement-time Binance spot-flow increase of roughly 50% versus the pre-launch level, a roughly 25% ten-second reversal in near-even cycles versus about 10% otherwise, and estimates $8.2m profit for 821 wallets, largely funded by retail. It finds the effect largely absent in 15-minute contracts. This validates a distortion in the **underlying spot market**. It does not show that a retail Polymarket trade entered after settlement is net profitable.

**Simple capture method.** Do not trade the terminal contract. Build an observational panel:

1. identify five-minute BTC contract tokens and their settlement/reference specification;
2. save CLOB depth, best executable quotes, fee parameters, and `itode`/market metadata around each close;
3. ingest the reference/spot price at −30, −10, 0, +10, and +60 seconds;
4. label near-even cycles ex ante; and
5. test whether the next linked contract offers a *fillable* post-settlement expression after both entry and exit costs.

**Honest economics.** There is no defensible Polymarket ROI or win-rate estimate yet. A taker version is especially unattractive: published crypto fees peak at 3.5% of trade value per side near 50¢, before spread. Only a maker-eligible, demonstrably fillable expression could plausibly survive that cost; it would still face adverse selection and superior-speed competitors.

**Decay and failure modes.** It is a manipulation/speed game, not durable price discovery. The relationship may vanish after the paper’s sample; the next contract may not preserve the relevant exposure; and a fill can mean the better-informed counterparty is happy to transfer the risk.

**Fastest kill experiment.** Collect **200 qualifying near-even cycles**. Kill it if a conservative next-contract paper simulation, entered and exited at depth-walked prices, fails to beat **two times its modeled fee burden**. Do not promote a spot reversal statistic into token PnL.

### 3.6 Rank #6 — Display-price/executable-price divergence: required overlay, not independent alpha

**Thesis.** Wide books invite traders to transact on a displayed midpoint or old last print, creating false impressions of probability movement. The potential loser is the trader mistaking that display for available liquidity.

**Evidence and limit.** Official documentation establishes the display rule, and Dubach’s 2026 microstructure study documents that longshot books can be wide. Both prove a cost/measurement problem. Neither establishes that displayed moves systematically revert after executable costs. Therefore “fade the UI” is not an approved strategy.

**Use it correctly.** Add these fields to the journal for every candidate—not only this lane:

```text
displayed price
best bid / best ask
VWAP buy and sell at proposed size
spread and depth through five levels
last trade age
book timestamp and staleness
```

The overlay can prevent phantom PnL and can identify where a passive order might be rational, but it receives **zero standalone capital** until a directionally testable rule passes a real-book experiment.

**Fastest kill experiment.** For 14 days, log instances with spread above 8¢ and a display move exceeding the executable-mid move by more than 4¢. Calculate future **executable**, not midpoint, returns. If no net reversion remains after fees and fill assumptions, retain only the measurement fields and discard the trade hypothesis.

---

## 4. Recommended order of work

This order maximizes information gained per unit of complexity and capital risk.

### Phase A — No-capital evidence (first 14 days)

1. **Structural scanner:** NegRisk/full-bundle and binary underrounds; record exact depth, fee-adjusted cost, event schema, window duration, and whether all legs are simultaneously available.
2. **Implication template scanner:** 20 manually signed-off threshold/nesting templates; retain both the payoff table and the rule URLs with every alert.
3. **Market-data journal:** use the tested `RealtimeOrderBook` machinery (`src/lib/realtimeOrderBook.ts`, `tests/realtimeCalendar.test.ts:63-86`) so an opportunity is measured as a book event, not as a slow polling artefact.

**Required output:** opportunity count by target size, distribution of locked gross, duration, and simulated one-leg unwind loss. No aggregate “ROI” is allowed without a completed-basket denominator.

### Phase B — Paper execution only (after a Phase A pass)

Paper-enter only baskets meeting all of the following:

* all legs fillable for the same small size;
* complete fee-adjusted cost below locked payout after a stated reserve;
* rule/event structure manually verified;
* execution journal can identify every individual leg, fill, partial fill, and unwind;
* unresolved inventory is counted at its executable liquidation value, not at a midpoint.

Start at $5–10 maximum per intended basket. The initial goal is to learn the partial-fill loss distribution, not to maximize theoretical lock return.

### Phase C — Parallel passive lanes

* Macro: eight scheduled releases before a live paper decision.
* Resolution text: 50-market manual audit before a rule-based strategy claim.
* BTC: 200 near-even cycles before a next-contract paper trade.

No live money is justified by a source paper alone.

---

## 5. Decision gates and reporting format

Every candidate should publish the same compact report:

| Field | Why it matters |
|---|---|
| Candidate and timestamp | Lets us measure opportunity duration and decay. |
| Rule/event identity | Proves the payoff relation rather than relying on a title. |
| Target shares and every book level consumed | Makes capacity explicit. |
| Per-leg raw cash, fee, all-in cost, and expected payout | Prevents fee/midpoint leakage. |
| First-leg fill, remaining-leg fills, and unwind fill | Separates true arbitrage from legging loss. |
| Terminal resolution / final cash PnL | Avoids unrealized-PnL storytelling. |
| Counterfactual blind fill | Shows whether the scanner added value beyond a naive attempt. |

Use **completed-basket PnL**, **one-leg inventory PnL**, and **unfilled candidate count** as separate metrics. Combining them hides the only operational fact that matters.

---

## 6. Bottom line

For this repository, the best new alpha is not a more complicated wallet score, a generic favorite model, or a speed race. It is a small number of **rule-backed, fee-adjusted payout identities** measured against live depth.

1. Start with NegRisk and ordinary binary underround measurement.
2. Add only manually proven implication templates, excluding the calendar lane that already exists.
3. Treat macro, BTC settlement effects, and resolution semantics as research monitors until current executable PnL exists.
4. Make display-vs-book divergence a universal risk control, never a hand-wavy alpha claim.

If the structural scanner produces no reserve-adjusted, depth-supported opportunities, kill it quickly. If it does, the existing FOK, basket-unwind, fee, and executable-PnL components make this the rare new lane that fits the bot’s actual philosophy: simple mechanism, real fills, honest losses, and no belief required.

---

## Sources

1. **Local implementation and evidence:** `src/jobs/scoreTrades.ts`, `src/jobs/paperUpdatePnl.ts`, `src/jobs/reviewOutcomes.ts`, `src/lib/liveExecution.ts`, `src/lib/scoring.ts`, `src/jobs/scanCalendarArbitrage.ts`, `docs/IMPORTANT_NOTES.md`, and `data/backtests/sports-favorites-2026-07-22T09-31-53-392Z.json`.
2. Oriol Saguillo, Vahid Ghafouri, Lucianna Kiffer, Guillermo Suarez-Tangil, “[Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets](https://doi.org/10.4230/LIPIcs.AFT.2025.27),” AFT 2025. The abstract documents two arbitrage forms and a realized $40m extraction estimate across the study period.
3. Cheng, Yang, and Zou, “[Arbitrage Analysis in Polymarket NBA Markets](https://arxiv.org/abs/2605.00864),” 2026. The abstract reports seven executable single-market episodes, 3.6-second median duration, 101 bps median combinatorial execution, and 14.8-share average constrained capacity.
4. Dai, Jia, and Yu, “[Settlement Manipulation in Prediction Markets](https://arxiv.org/abs/2606.31675),” 2026. The paper documents settlement-time underlying-market reversal after five-minute BTC contract launch; it does not establish a retail Polymarket trading return.
5. Aktuğ and Torul, “[Informational Inertia in a Decentralized Prediction Market: Evidence from the May 2024 CPI Leak](https://web.bogazici.edu.tr/torul/inertia.pdf),” 2026. Single-event, pre-growth baseline used here only to justify a replication monitor.
6. Polymarket, “[Fees](https://docs.polymarket.com/trading/fees).” Fee formula, category rates, maker fee of zero, and current fee examples.
7. Polymarket, “[Negative Risk](https://docs.polymarket.com/concepts/negative-risk).” NO-to-other-YES conversion mechanics.
8. Polymarket, “[Prices and Order Book](https://docs.polymarket.com/concepts/prices-orderbook).” Displayed midpoint/last-trade behavior and CLOB pricing context.
9. Polymarket, “[Resolution](https://docs.polymarket.com/concepts/resolution).” Proposal, challenge, disputes, and clarification mechanics.

**Source discipline:** links were reviewed on 2026-07-29. Claims beyond the cited sources are explicitly labelled as a proposed experiment, operational rule, or unknown—not as established alpha.
