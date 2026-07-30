# Polymarket Alpha Memo — July 29, 2026

## Verdict

**Highest-EV strategy: build an external fair-value router, starting with crypto threshold markets.**

The engine should normalize a Polymarket contract into an exact payoff definition, calculate fair probability from a faster or economically equivalent market, obtain the executable Polymarket quote, and trade only the residual after fees, slippage, and hedge cost.

First implementation:

1. **BTC/ETH threshold contracts versus Deribit/Binance options.**
2. **Resolution-source certainty trades.**
3. **Logical and cross-platform inconsistencies using the same contract-normalization layer.**

This is stronger than another wallet-scoring expansion because it generates an independent probability estimate. Wallet flow then becomes confirmation—not the source of truth.

The repository already contains the correct execution philosophy: aggregate wallet fills into campaigns, measure remaining executable upside, require actual CLOB quotes, record all-in prices and hold to resolution. It also correctly abandoned its composite market score when higher scores failed to predict profits, retaining the features that actually worked. fileciteturn5file0L13-L65 fileciteturn10file0L126-L166 fileciteturn16file0L41-L121

**Evidence limitation:** I inspected the GitHub code, official current mechanics, and recent empirical work. The repository’s SQLite trading database was not available through GitHub, so I could not run a new trade-level replay of your private observations. Most 2026 studies below are working papers or preprints. The ROI ranges are my executable-edge priors, not claimed realized performance.

## Ranking

| Rank | Strategy | Net-edge prior | Feasibility | Decay |
|---:|---|---:|---:|---|
| 1 | Crypto option-implied basis | 4–15% ROI/trade | High | Medium |
| 2 | Resolution-source certainty lag | 2–6% ROI/fill | High | Medium |
| 3 | Abnormal wallet-market campaign copy | 5–15% ROI/trade | High | Medium |
| 4 | Cross-venue exact/semantic basis | 2–8% normally; occasional 10%+ | Medium | Medium |
| 5 | Logical dependency arbitrage | 1.5–5% locked ROI | High | Slow–medium |
| 6 | Scheduled-information latency | 3–12% ROI/trade | Medium | Fast |
| 7 | Late-game insurance-demand fade | 2–8% ROI/trade | High | Medium |
| 8 | Reward-subsidized directional making | 0.2–1.0% deployed capital/day hypothesis | Medium | Fast |

---

## 1. Crypto option-implied probability basis

**Mechanism.** Match Polymarket BTC/ETH threshold markets to listed options with the same underlying, strike, expiry, and settlement definition. Infer the risk-neutral digital probability from the option surface. Buy Polymarket when its executable all-in price is materially below that probability; optionally delta-hedge with futures.

**Who loses and why it persists.** Prediction-market traders buy intuitive lottery-like narratives; option markets are dominated by volatility and hedging flows. Capital, account access, contract semantics, and different participant bases prevent instant convergence.

**Evidence.** A June 2026 preprint found a 5.6-percentage-point mean gap over 214 hourly observations for its main BTC contract, 6.3 points pooled across three Binance-compatible markets, approximately four-hour mean-reversion half-life, and an 11-point pooled gap using Deribit. The wedge was strongest at low probabilities and longer maturities. Its delta-hedged proxy remained profitable after conservative costs, although statistical precision was marginal. ([arxiv.org](https://arxiv.org/abs/2606.19517))

Polymarket’s crypto taker fee is:

`shares × 0.07 × price × (1-price)`

At 50¢ this costs 1.75¢ per share. A 6.3-point raw discrepancy therefore leaves approximately 4.55 points before slippage and hedge costs; an 11-point gap leaves 9.25 points. Makers pay no fee. ([docs.polymarket.com](https://docs.polymarket.com/trading/fees))

**Capture.** Do not use Black–Scholes mechanically. Fit the listed implied-volatility surface, interpolate total variance across strikes, derive the digital using the strike derivative of call prices, and verify settlement-source equivalence. Enter when:

`abs(option_probability − Polymarket_all_in) > PM_fee + hedge_cost + 0.02`

Start with low-probability BTC YES contracts, where both the documented wedge and capital ROI are largest.

**Risks and decay.** Option probabilities are risk-neutral, not necessarily real-world probabilities. Settlement timestamps or source exchanges may differ. Sparse options require interpolation. The edge will shrink once direct option-comparison bots proliferate, but contract fragmentation should preserve some basis.

**Edge prior.** About 2.5–8 probability points after one Polymarket taker fee and reasonable execution costs; roughly **4–15% expected ROI on cash paid**, depending on entry price.

**Fastest kill test.** Collect every active BTC/ETH threshold market for 72 hours. Snapshot executable Polymarket depth and Binance/Deribit surfaces every minute. Simulate exact-size entries and hedge costs. Kill it if fewer than ten executable observations exceed 3 net probability points, or if subsequent convergence does not exceed costs.

---

## 2. Resolution-source certainty lag

**Mechanism.** Trade the exact source specified by the market—not the general news event. Once that source makes the outcome mechanically certain, buy the winning token while stale asks remain before CLOB repricing or formal resolution.

Polymarket rules explicitly specify the resolution source, eligibility date, and edge cases. Undisputed resolution normally takes approximately two hours after proposal; disputed cases may take four to six days. ([docs.polymarket.com](https://docs.polymarket.com/concepts/resolution))

**Who loses and why it persists.** Casual traders monitor headlines. Many market makers monitor market prices. Fewer systems continuously parse every named government webpage, statistical release, sports feed, court docket, corporate filing, GitHub release, weather station, or resolution clarification. Stale orders remain after the truth has become source-final.

**Evidence.** The official Sports WebSocket publishes status, score, whether an event has ended, and a `finished_timestamp`; the market WebSocket independently publishes book changes and eventual resolution. This creates a directly measurable interval between source-finality, book repricing, and formal settlement. ([docs.polymarket.com](https://docs.polymarket.com/market-data/websocket/market-channel))

Your repository already identifies this as a distinct lane but has not treated it as the primary independent alpha source. fileciteturn4file0L68-L82

**Capture.** Maintain a small adapter per repeatable source family:

- Sports official result or Polymarket sports status.
- Government statistics and agency publications.
- Court and election authority results.
- Named crypto-price oracle or settlement exchange.
- Weather station observations.
- Corporate filings and release pages.

When the resolution predicate evaluates true, sweep only asks whose all-in return remains attractive. Near extremes, taker fees become small. For example, a sports token purchased at 97¢ incurs approximately 0.087¢ fee per share under the current formula, leaving close to a 3% return if correct. ([docs.polymarket.com](https://docs.polymarket.com/trading/fees))

**Risks and decay.** The named source may later revise data; “event happened” may not equal the exact rule predicate; sports feeds can be wrong; visible depth may vanish. This edge decays quickly for common feeds but slowly across long-tail sources.

**Edge prior.** **2–6% net ROI per executable fill**, with very high win rates possible only for genuinely source-final conditions. Capacity is the bottleneck.

**Fastest kill test.** Monitor 200 sports, weather, and scheduled-data markets. Record source-final timestamp, first executable winning ask, available depth, and resolution timestamp. Kill if fewer than ten source-certain entries remain below 98¢, or if executable depth averages under $25.

---

## 3. Abnormal wallet-market campaign copy

**Mechanism.** Stop treating wallet lifetime identity as the primary unit. Detect unusually informed **wallet-market pairs**: a new or normally inactive wallet suddenly placing a concentrated, unusually large, rapidly accumulated campaign in one event.

**Who loses and why it persists.** The public leaderboard detects durable winners only after their success. Event-specific informed traders may have no prior track record and may never trade again. Retail traders and slow copy bots initially treat them as noise.

**Evidence.** A 2026 study screened Polymarket activity from February 2024 through February 2026 using cross-sectional bet size, within-wallet size, profitability, pre-event timing, and directional concentration. It identified more than 210,000 suspicious wallet-market pairs; flagged observations had a 69.9% win rate and approximately $143 million in estimated anomalous profit. Crucially, the authors argue that the wallet-market pair—not the wallet—is the correct unit because information may concern only one event. ([papers.ssrn.com](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6426778))

Separately, cross-platform research found that directional imbalance from large trades predicts subsequent returns and that the venue receiving stronger large-trade flow tends to lead price discovery. ([papers.ssrn.com](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5331995))

**Capture.** Create a separate candidate lane using only live-observable variables:

`anomaly = size_z_across_market + size_z_within_wallet + portfolio_concentration + fill_velocity + wallet_newness + independent_consensus`

Do not require leaderboard membership. Aggregate fills exactly as the repository already does, then copy only when enough remaining upside survives the executable quote. fileciteturn4file0L48-L66 fileciteturn5file0L27-L65

Strongest form:

- Wallet has little prior activity.
- Campaign is several standard deviations above normal market trade size.
- Most wallet capital enters one outcome.
- Multiple fills show deliberate scaling rather than one accidental trade.
- One or more unrelated profitable wallets independently follow.
- Price has not already consumed most of the payoff.

**Risks and decay.** Large positions can be hedges, market-making inventory, or manipulation. Historical profitability must never enter the live score because that is future leakage. Copying public fills will eventually compress the signal.

**Edge prior.** Target **3–8 points of forward probability edge**, corresponding to roughly **5–15% expected ROI** at normal 50–70¢ entries. Confidence is lower than for the first two strategies.

**Fastest kill test.** Replay historical Data API trades and run the signal forward live. Compare top-decile anomalous campaigns with matched controls at 5 minutes, 1 hour, 6 hours, and resolution. Kill if top-decile excess return is below 2 points after executable entry assumptions.

---

## 4. Cross-venue exact and semantic basis

**Mechanism.** Match Polymarket contracts against Kalshi, PredictIt, Robinhood, or another venue. There are two trades:

1. **Exact equivalence:** buy YES cheaply on one venue and NO cheaply on the other when combined cost is below guaranteed payout.
2. **Semantic basis:** exploit differences in deadlines, named legislation, resolution sources, or definitions that create a state where both contracts win—or where one probability must dominate the other.

**Who loses and why it persists.** The venues have different customer populations, funding rails, geographic access, regulations, fees, and contract wording. Capital cannot move instantly, and apparently equivalent titles often hide material rule differences.

**Evidence.** One June 2026 study of the same Clarity Act event on Polymarket and Kalshi found probability spreads as large as 26.1 points. A threshold mean-reversion rule produced nine winning trades, 15.6% average net return, and a 5.9-day mean hold. This is compelling but only one contract and nine trades. ([papers.ssrn.com](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6861841))

A later case study found two semantic-basis portfolios across Polymarket, Kalshi, and PredictIt that remained profitable after fees and a 4% annual opportunity cost assumption. ([papers.ssrn.com](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6984101))

**Capture.** Build a manually verified market map first—no ambitious universal NLP system. Normalize:

`event identity, deadline, source, legal trigger, geography, cancellation rule, 50/50 rule`

Calculate every state-contingent payoff before calling something arbitrage. Use paired execution or aggressively hedge the more liquid leg first.

**Risks and decay.** Venue access may be the main constraint. Settlement semantics create basis risk. One leg may fill while the second moves. Capital can be trapped until resolution. Exact equivalence will decay faster than semantic differences.

**Edge prior.** **2–8% net ROI** for repeatable discrepancies. Occasional semantic structures can exceed 10%, but should not be the baseline assumption.

**Fastest kill test.** Manually map 50 current cross-listed contracts. Collect executable quotes for seven days and calculate paired fills after both venues’ fees. Kill if fewer than five opportunities provide at least 2% locked or strongly hedged return with $100 of executable depth.

---

## 5. Logical dependency arbitrage

**Mechanism.** Search for probability relationships that must hold across markets:

- Earlier deadline YES ≤ later deadline YES.
- Higher price threshold YES ≤ lower threshold YES.
- Championship YES ≤ semifinal qualification YES.
- Candidate wins presidency ≤ candidate wins nomination.
- “Event occurs and condition X” ≤ “event occurs.”
- Exhaustive mutually exclusive outcomes sum to 1.

For implication `A ⇒ B`, buying `NO(A) + YES(B)` guarantees at least $1. Therefore, any executable combined cost below $1 is arbitrage. A 96¢ cost gives 4.17% gross ROI.

**Who loses and why it persists.** Traders price narratives market by market rather than as a joint probability graph. Different markets have different followers, liquidity, and creation times. Multi-leg fill risk and capital lockup deter manual arbitrageurs.

**Evidence.** A large on-chain study identified intra-market rebalancing and cross-market combinatorial arbitrage and estimated approximately **$40 million in realized extracted profit** during its sample. ([drops.dagstuhl.de](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.AFT.2025.27))

But the strategy must avoid fake headline arbitrage. A separate analysis of 75 million NBA order-book snapshots found only seven executable same-market episodes, with median duration 3.6 seconds. Combinatorial opportunities were more frequent and returned a median 101 basis points, but 76.9% were constrained to an average 14.8 shares. ([arxiv.org](https://arxiv.org/abs/2605.00864))

**Capture.** Use a finite template library, not a giant semantic agent:

- Dates.
- Numeric thresholds.
- Tournament progression.
- Mutually exclusive outcomes.
- Parent/child event predicates.
- Explicit conjunctions.

Parse market rules once, store the relationship, and continuously price the executable basket. Trade only if minimum guaranteed payout exceeds all-in basket cost by at least 1.5–2%.

**Risks and decay.** Rule wording may invalidate apparent implication. Multi-leg non-atomic execution is the main loss mechanism. The purest, easiest relationships will be crowded; long-tail relationships should decay more slowly.

**Edge prior.** **1.5–5% locked ROI**, normally modest depth. Larger violations are possible but rarer.

**Fastest kill test.** Scan all active markets for date ladders, threshold ladders, and tournament dependencies. Simulate simultaneous executable fills for seven days. Kill if fewer than ten baskets exceed 1.5% net with at least $100 depth.

---

## 6. Scheduled-information latency

**Mechanism.** Convert official releases into contract probabilities faster than Polymarket participants: CPI, payrolls, FOMC, GDP, election counts, court rulings, corporate earnings, SEC filings, weather updates, and similar discrete events.

**Who loses and why it persists.** Retail traders watch news alerts and manually interpret releases. Thin books may have no professional market maker actively maintaining a model. The slowest contracts are usually not the largest headline markets but secondary implications of the release.

**Evidence.** During the May 2024 CPI leak, the BLS uploaded the report at 08:00 ET. CME Fed Funds futures adjusted within seconds, while the studied Polymarket contracts did not materially reprice until 08:35—five minutes after the official scheduled release. This is one historical episode, not proof that the same 35-minute lag remains today. ([sciencedirect.com](https://www.sciencedirect.com/science/article/pii/S1544612326009062))

Polymarket’s WebSocket provides real-time books and best bid/ask updates, making release-to-price latency directly measurable without REST polling. ([docs.polymarket.com](https://docs.polymarket.com/market-data/websocket/market-channel))

**Capture.** Precompute a local mapping from release values to relevant contracts. At timestamp zero:

1. Parse the primary source.
2. Read the immediate move in CME, Treasury, FX, crypto, or equity markets.
3. Reprice every linked Polymarket contract.
4. Sweep stale orders only where the model change exceeds all-in costs.

The richest opportunity may be the second-order contract—for example, the release’s implication for a Fed decision—rather than the literal CPI bucket.

**Risks and decay.** This is the fastest-decaying edge. Public release formats change. Revisions and interpretation matter. The largest contracts may already be efficient. Network latency becomes material.

**Edge prior.** **2–8 probability points** on genuine stale-book events; approximately **3–12% ROI** depending on entry price. Frequency will be low.

**Fastest kill test.** Replay archived Polymarket quotes around the last 30 scheduled releases and record the gap versus the first move in the institutional benchmark. Kill if the median executable lag is under two seconds or the median residual move after entry is below 2 points.

---

## 7. Late-game insurance-demand fade

**Mechanism.** In the closing minutes of sports events, holders of losing positions may overpay for comeback insurance or emotionally chase miracle outcomes. That makes the live favorite cheaper than an external score-state model implies. Buy the favorite—not the comeback longshot—when Polymarket trails sportsbooks or a calibrated win-probability model.

**Who loses and why it persists.** Losing bettors value a small chance of recovery more than its actuarial value. Others buy the dramatic longshot because the payoff is salient. This is recurring retail behavior tied to the event lifecycle.

**Evidence.** A July 2026 study using 23 million Kalshi moneyline trades found that calibration changes sharply in the final ten minutes, becoming step-like in a pattern consistent with insurance demand from holders of losing positions. That result is from Kalshi, so transfer to Polymarket must be proven rather than assumed. ([arxiv.org](https://arxiv.org/abs/2607.14430))

The broader favorite–longshot evidence is consistent with your repository’s early result: the 60¢ favorite gate made +$7.81 across 45 resolved copies versus −$21.42 for blind copying. The sample is too small to establish the final-ten-minute effect, but the direction matches. fileciteturn4file0L29-L39

**Capture.** Use live score, possession/server state, time remaining, external sportsbook odds, and executable CLOB price. Enter only when:

`external_fair_probability − Polymarket_all_in ≥ 0.03`

Focus on repeatable state-rich sports: tennis, basketball, baseball, and esports. The external model is essential; merely buying every late favorite will buy already-correct 98–99¢ outcomes with poor payoff.

**Risks and decay.** External sportsbook odds contain margin and can lag. Game-state feeds can be wrong. Suspensions and overturns create tail losses. The effect may not transfer from Kalshi.

**Edge prior.** **1–4 probability points**, or roughly **2–8% expected ROI** at 50–85¢ entries.

**Fastest kill test.** Replay at least 300 Polymarket games, sampling every 30 seconds in the final ten minutes. Compare executable prices with de-vigged sportsbook probabilities and final results. Kill if the residual calibration edge is below 1.5 points after fees.

---

## 8. Reward-subsidized directional market making

**Mechanism.** Quote as a maker only where spread capture, maker rebates, and liquidity rewards jointly exceed expected adverse selection. Skew inventory toward the side favored by one of the independent signals above.

**Who loses and why it persists.** Takers pay fees and cross spreads for urgency. Polymarket subsidizes liquidity directly. Undercontested long-tail markets can temporarily distribute disproportionate rewards to small but consistently present makers.

Makers currently pay zero platform fee. Eligible makers receive daily rebates proportional to the fee-equivalent value of their filled liquidity within each market. Separate liquidity rewards score resting depth, proximity, and often two-sided quoting. ([docs.polymarket.com](https://docs.polymarket.com/market-makers/maker-rebates))

**Evidence.** This is not speculative platform behavior—the rebate and reward mechanisms are documented. The unknown is whether any current market’s reward pool remains profitable after competition and adverse selection. Current reward configurations can be retrieved programmatically from the official rewards endpoint. ([docs.polymarket.com](https://docs.polymarket.com/api-reference/rewards/get-current-active-rewards-configurations))

**Capture.** Every hour rank markets by:

`expected_reward_share + expected_rebate + spread_capture − adverse_selection`

Quote two sides for reward eligibility, but skew sizes and prices toward your calculated fair value. Avoid quoting symmetrically through known catalysts. Use WebSocket updates and batch order replacement; official guidance explicitly recommends WebSockets, batching, and cancelling before catalysts. ([docs.polymarket.com](https://docs.polymarket.com/market-makers/trading))

**Risks and decay.** Reward pools and competing depth change rapidly. A nominal reward can be overwhelmed by one informed fill. This requires more execution work than the directional strategies above.

**Edge prior.** Initial hypothesis: **0.2–1.0% per day on actually deployed quoting capital** in undercontested rewarded books. This range is not externally verified and should be killed quickly if absent.

**Fastest kill test.** Rank ten current rewarded markets and quote $50–$100 per market for 48 hours. Attribute PnL separately to spread, rebates, rewards, inventory mark, and resolution. Kill if rewards plus spread are below 0.2% per day or adverse selection consumes more than half of gross income.

---

## What not to build first

**Pure YES+NO same-market arb:** real, but the NBA evidence shows only seven executable in-game episodes, lasting a median 3.6 seconds. Too little capacity for a primary strategy. ([arxiv.org](https://arxiv.org/abs/2605.00864))

**Generic five-minute BTC prediction:** a June 2026 study found settlement-time spot-flow spikes and reversals after five-minute contract settlement, with profits concentrated among manipulators and losses among retail participants. Competing directly requires superior index-level latency or the ability to anticipate settlement pressure; the 15-minute contracts showed much less manipulation. ([arxiv.org](https://arxiv.org/abs/2606.31675))

**Generic LLM forecasting:** recent live-market benchmarks have not demonstrated a dependable broad forecasting engine, and your repository correctly prioritizes measurable structural or information signals instead. fileciteturn4file0L106-L115

**Broad composite scoring:** your code already discovered the central failure mode—an elegant combined score did not rank returns reliably. Keep independent edges isolated and measure realized PnL per mechanism. fileciteturn10file0L126-L166

## Build tomorrow

Build one lean **external-state lane**:

1. Normalize each candidate into  
   `underlying | predicate | strike | deadline | resolution source | token`.
2. Produce `fair_probability` from Deribit/Binance first; add exact resolution feeds second.
3. Obtain the exact-size CLOB quote and trade when  
   `fair_probability − all_in_price − hedge_cost ≥ minimum_edge`.

Log only:

`fair probability, raw PM price, all-in price, source timestamp, size available, hedge cost, final outcome, realized PnL`.

**First capital deployment:** BTC threshold contracts with at least a 4-point net model gap.  
**Second:** source-final sports or official-data outcomes below 98¢.  
**Third:** anomalous wallet-market campaigns confirmed by either external fair value or independent-wallet consensus.

That combination has the strongest evidence, highest plausible return on limited capital, and the shortest path from this repository to a materially more profitable system.
