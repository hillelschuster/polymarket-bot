# Wallet Index Alpha — Deep Audit and V2 Proposal

## Objective

Strengthen the wallet-copy signal so it produces more realized net PnL without destroying the proven mechanism:

> discover skilled wallets → observe meaningful positions quickly → buy remaining edge at executable CLOB prices → hold or follow the source exit → compound.

This document audits the current `main` implementation, identifies the largest signal defects, answers the wallet-trust questions directly, and proposes three concrete upgrades ranked by expected profit impact.

The core conclusion:

> The wallet thesis is valid, but the correct unit is not “wallet” alone. The production signal should be hierarchical: **entity prior → wallet → wallet-category → event campaign → executable entry**.

A wallet can be globally mediocre but exceptional in one category. A globally strong wallet can make a low-conviction or late position. An unknown wallet can produce one highly abnormal, informed-looking position. The system should preserve all three possibilities through sizing rather than blunt inclusion/exclusion.

---

# 1. What `main` Actually Does

## 1.1 Wallet universe

`src/jobs/scanLeaderboard.ts` calls `paginateLeaderboard(500)` and upserts roughly 500 wallet profiles.

That sounds like a 500-wallet index, but the practical universe is much smaller:

1. `paginateLeaderboard(500)` does not specify leaderboard horizon or ordering.
2. Polymarket's current API defaults to `DAY` and `PNL`.
3. The database records `lookbackDays: 30`, but the request is not a 30-day request.
4. `scanWallets.ts` only fetches live leaderboard metrics for 50 wallets.
5. Only wallets with `sourceRank <= 50` are eligible for enrichment.
6. Only 18 of those 50 are refreshed in one slow pass.
7. Each enriched wallet uses only the latest 20 trades.
8. `monitorTrades.ts` polls only wallets whose status is `track`.

Therefore the current mechanism is not yet an actively managed S&P 500. It is closer to:

> ingest 500 daily PnL-ranked names → deeply inspect a rotating subset of the current top 50 → monitor wallets that pass a coarse global threshold.

This matters because daily PnL leaderboards are dominated by recent event winners, large positions, market makers, and temporary luck. Durable skill and category specialization can sit outside the daily top 50.

### Hidden API defect

The current adapter sends `time_period` and `order_by` if those fields are supplied. Current Polymarket documentation uses `timePeriod` and `orderBy`. Snake-case parameters can silently fall back to API defaults.

Lane B now corrects those query names and allows pagination with explicit scope parameters.

## 1.2 Wallet score

The `main` wallet score is:

```text
0.30 × ROI score
+ 0.20 × consistency
+ 0.20 × copyability
+ 0.10 × best category edge
- one-hit penalty
- illiquidity / sparse-history penalties
```

The inputs are:

- leaderboard `pnl / volume` proxy called `roi30d`;
- win rate from resolved trades when at least three exist;
- otherwise live directional mark-to-market win rate;
- trade count;
- average market liquidity and spread;
- average time before resolution;
- maximum observed category win rate;
- PnL variance;
- one-hit concentration.

### What those inputs really mean

`pnl / volume` is not return on deployed capital. It is closer to profit per dollar of turnover. A fast trader who repeatedly rotates capital can look worse than a concentrated trader even when the fast trader compounds better.

`tradeCount30d` is not necessarily a 30-day count. It is the number of rows returned from the latest-trades call, currently capped at 20 on `main`.

The win-rate fallback uses open directional marks. A trade that is temporarily up is treated as a win even if it later resolves against the wallet. This is useful as a weak live signal, but it is not equivalent to resolved skill.

Category edge is the maximum category win rate with as few as two observations. Selecting the maximum across noisy categories creates winner's-curse inflation.

The score is fill-based rather than event-based. Multiple fills in one market can inflate sample count and distort variance, frequency, category evidence, and one-hit calculations.

## 1.3 Admission gates

`src/jobs/scoreTrades.ts` on `main` applies:

1. BUY only.
2. Maximum signal age: 20 minutes sports, 10 minutes other categories.
3. Minimum wallet global score: 35.
4. Wallet-copy performance filter.
5. Persistent market-token deduplication.
6. Sports timing validation.
7. Spread hard gate: 5%.
8. Price adverse-move and entry-gap gates.
9. Liquidity range: $10,000 to $500,000.
10. Volume/liquidity toxic-flow gate.
11. Category-specific favorite threshold.
12. Maximum all-in entry price: 0.80.
13. Executable CLOB depth and fee quote.

The strongest parts are executable pricing, favorite selection, freshness, spread control, and wallet feedback.

The largest structural weakness is that admission starts from one observed fill and one wallet global score. It does not model campaigns, independent consensus, category posterior skill, conviction, or remaining edge as a probability.

## 1.4 Non-sports are not explicitly banned in this code

The current `main` scoring code does **not** contain a universal sports-only rejection. It already defines favorite gates for politics, sports, crypto, esports, and a default category.

Non-sports are practically disadvantaged by:

- weaker category detection;
- 10-minute freshness instead of 20 minutes;
- generic three-day minimum resolution timing;
- the source-wallet population being sports-heavy;
- sparse category history;
- coarse global wallet ranking.

So the next step is not simply “remove the sports restriction.” The better step is:

> make category intelligence real, then allow every category at a size proportional to evidence and remaining edge.

---

# 2. What Is Already Good

Do not replace these components.

## Executable entry economics

The bot quotes the actual intended cash amount through the CLOB and includes depth and fees. This prevents midpoint fantasy PnL.

## Favorite-longshot structure

The favorite gate is the strongest currently validated market-level feature. Wallet skill and favorite bias are complementary:

- wallet tells us where information may exist;
- favorite bias tells us which price region has structural support;
- executable pricing tells us whether the edge remains for us.

## Real-time wallet feedback

The bot already closes the loop between copied-wallet results and future admission. That is directionally correct. The evidence unit and normalization need improvement, not removal.

## Freshness and price deterioration

A copied trade is not the same trade if our executable price is materially worse. Freshness and entry deterioration should remain first-class variables.

## Diversified source universe

The broad leaderboard universe is strategically valuable. The error is not having too many wallets. The error is reducing their heterogeneous evidence to one coarse score and deeply evaluating only a small daily-ranked subset.

---

# 3. Core Problems in the Current Wallet Ranking

## 3.1 Daily leaderboard selection creates churn and survivorship bias

The current default universe is daily PnL-ranked. This creates several distortions:

- one large resolved win can launch a wallet into the top ranks;
- a durable low-frequency specialist may disappear between trades;
- market makers can rank highly because of scale;
- a recent winner is selected after the profitable information may already be exhausted;
- daily ranking changes faster than the enrichment cycle.

The correct universe is a union of multiple independent discovery channels, not one leaderboard snapshot.

## 3.2 Raw win rate ignores price

A wallet winning 85% of bets at an average entry of 0.90 is losing expected value.

A wallet winning 65% at an average entry of 0.50 has enormous edge.

Trust must be measured relative to the market probability at entry.

For resolved event `i`:

```text
outcomeResidual_i = y_i - entryPrice_i
```

where `y_i` is 1 for a win and 0 for a loss.

A practical wallet edge estimate is:

```text
rawEdge = mean(y_i - entryPrice_i)
```

This measures excess accuracy over the price paid. It is superior to win rate alone.

The economic return for a BUY held to resolution is:

```text
return_i = (y_i - allInEntry_i) / allInEntry_i
```

Both should be retained:

- probability edge measures forecasting skill;
- net return measures monetizable skill after price and fees.

## 3.3 Fills are not independent bets

A wallet can split one thesis into 20 fills. Counting those as 20 independent observations fakes frequency and confidence.

The correct unit is an event campaign:

```text
wallet + token + directional campaign window
```

A campaign aggregates:

- first entry time;
- weighted average entry;
- total shares and notional;
- scale-ins;
- reductions;
- exit;
- maximum conviction;
- resolution outcome.

Wallet skill should be calculated over unique campaigns or unique events, not raw fills.

## 3.4 Global wallet averages dilute episodic information

Public informed-trading research increasingly reaches the same conclusion: suspected information advantage often exists at the trader-event level, not uniformly across every trade from a wallet.

A wallet may be:

- ordinary in sports;
- excellent in Google-related culture markets;
- informed once in a military event;
- unprofitable elsewhere.

A global score should be a prior. It should not dominate the event-level signal.

## 3.5 Frequency and trust are incorrectly mixed

The monthly 100% wallet versus daily 75% wallet question should not be answered with one score.

Use two axes:

### Per-signal trust

How much positive edge is expected when this wallet trades in this category?

### Opportunity capacity

How often does it generate copyable signals?

A sparse wallet can have high per-signal trust and low capacity. It should remain monitored and receive meaningful size when it finally acts, subject to uncertainty.

A frequent wallet can have moderate per-signal trust and high monthly profit contribution.

The production allocator should optimize expected dollars, not rank one dimension against the other:

```text
expectedMonthlyAlpha ≈ expectedEdgePerSignal × expectedSignalsPerMonth × copyableCapital
```

Do not lower a rare wallet's per-trade trust merely because it trades rarely. Lower confidence only because the evidence sample is sparse.

## 3.6 No Bayesian shrinkage

Two wins out of two should not be treated as 100% true skill.

But it also should not be discarded.

Use shrinkage:

```text
shrunkCategoryEdge =
  categorySampleWeight × observedCategoryEdge
  + walletPriorWeight × walletGlobalEdge
  + platformPriorWeight × categoryBaseEdge
```

A simple practical weight is:

```text
sampleWeight = n / (n + k)
```

where `k` can start around 8–15 unique resolved campaigns and be validated live.

This produces the desired behavior:

- 2/2 specialist: promising, exploratory or moderate size;
- 12/12 specialist: high trust;
- 200 trades at weak edge: reliable but not necessarily attractive;
- one monthly trade over 18 months: sparse frequency but potentially strong trust.

## 3.7 Drawdown is missing

Variance is not drawdown.

Drawdown captures whether a wallet's realized edge arrives through smooth compounding or catastrophic runs.

Calculate a normalized campaign equity curve using return on stake, with extreme wallet sizing capped so one giant trade does not define the metric.

Track:

- maximum peak-to-trough drawdown;
- worst 10% average return;
- longest losing streak;
- time to recover;
- drawdown by category;
- drawdown when copied at our delay and executable price.

Use drawdown primarily as a sizing multiplier, not a permanent rejection gate.

Example:

```text
riskMultiplier = clamp(1 - 0.75 × maxDrawdown, 0.40, 1.00)
```

The exact coefficient is not sacred. The principle is:

> low drawdown earns more capital; high drawdown receives smaller positions unless expected edge is unusually strong.

## 3.8 Current copy feedback is scale-dependent and mark-sensitive

On `main`, a wallet can be penalized by absolute open-dollar PnL and a fixed `$-3` loss threshold. This is unstable:

- larger paper sizes lose more dollars for the same return;
- temporary open marks can blacklist a good hold-to-resolution wallet;
- a $3 loss means something different at a $100 versus $10,000 bankroll;
- performance is global rather than category-specific.

Resolved ROI and probability residual should dominate. Open marks should measure short-horizon execution quality and alpha decay, not final trust.

Lane B already moves in the correct direction by separating resolved evidence from temporary open PnL.

## 3.9 Copyability is not measured directly enough

Current copyability uses average liquidity, spread, frequency, and entry timing.

The actual question is:

> After we detect this wallet, how much edge remains at our executable price?

Measure per wallet-category:

- wallet fill to our quote deterioration;
- detection latency;
- 30-second, 2-minute, 10-minute, 1-hour, and final price changes;
- executable depth at intended size;
- missed-fill rate;
- maker-fill probability;
- alpha half-life.

A wallet that is highly skilled but moves the market instantly can be less copyable than a slower research wallet.

## 3.10 Consensus currently lacks independence

Raw wallet count is not enough.

Three wallets can be:

- one person using three proxies;
- a copy-trading cluster;
- three bots responding to the same public feed;
- three truly independent specialists.

Only the final case deserves full consensus weight.

Consensus needs soft entity and behavioral clustering. Do not require proof of common ownership. Penalize likely dependence.

---

# 4. Direct Answers to the Trust Questions

## Track entire wallets or specific positions?

Both, in a hierarchy.

### Wallet-level prior

Use durable global evidence:

- price-adjusted resolved edge;
- net ROI;
- unique event count;
- recency;
- drawdown;
- copyability;
- category concentration;
- out-of-sample persistence.

### Position-level decision

Use:

- category-specific posterior edge;
- abnormal size relative to the wallet's own history;
- fraction of wallet capital committed;
- whether it is an initial entry or scale-in;
- timing relative to event lifecycle and public news;
- wallet's historical alpha half-life;
- independent consensus;
- current executable all-in price;
- remaining edge.

Do not copy every position from a trusted wallet. Do not ignore an exceptional position merely because the wallet is not globally elite.

## How should suspected insiders be identified and weighted?

Never label a wallet an insider from performance alone. Use an `informedLikeScore` at the wallet-event level.

Useful components:

1. **Size anomaly** — position notional versus that wallet's normal notional and versus market depth.
2. **Conviction** — fraction of visible wallet capital concentrated in the event.
3. **Timing** — entry shortly before a discrete public announcement or resolution-driving event.
4. **Directional concentration** — one-sided activity rather than market-making churn.
5. **Price efficiency** — entry at a price that later proves sharply wrong.
6. **Permanent price impact** — price moves toward the position and does not revert.
7. **Category specificity** — repeated success in one information domain.
8. **Lifecycle abnormality** — newly created or previously dormant wallet, concentrated campaign, rapid withdrawal or dormancy afterward.
9. **Cross-wallet linkage** — sibling-looking wallets entering the same event.

Suggested use:

```text
baseSize = walletCategoryTrust × remainingEdge
informedMultiplier = 1 + min(0.75, informedLikeScore)
```

Do not make `informedLikeScore` a mandatory gate. It is a conviction multiplier and discovery channel.

## Monthly 100% wallet or daily 75% wallet?

Do not force a single winner.

- Daily 75% wallet likely contributes more total opportunities.
- Monthly 100% wallet may have higher per-signal edge but wider uncertainty.

Rank them separately on:

```text
trustPerSignal
signalsPerMonth
copyability
expectedDollarsPerMonth
```

The rare wallet stays on a low-frequency polling lane. When it acts, its position is scored normally with posterior uncertainty.

## How should drawdown affect ranking?

Drawdown should reduce size and expected capital efficiency, not automatically cause `DROP`.

A high-edge, high-drawdown wallet may remain profitable at smaller size. A low-drawdown specialist can receive more capital even if its raw PnL is lower.

Use resolved campaign returns, not temporary fill marks, for the main drawdown statistic.

---

# 5. Proposal 1 — Multi-Horizon Specialist Universe + Hierarchical Skill

## Rank

**#1 priority. Highest expected profit per implementation effort.**

## Profit leak fixed

The current universe is selected from daily PnL and deeply evaluates only the top 50. Durable specialists, rare informed wallets, and category experts are systematically missed. Daily one-hit winners are systematically overrepresented.

## Universe construction

Build a deduplicated union of:

- overall DAY PnL;
- overall WEEK PnL;
- overall MONTH PnL;
- overall ALL PnL;
- category MONTH PnL for sports, politics, crypto, culture, mentions, economics, tech, finance, and weather;
- wallets with repeated profitable closed positions outside leaderboard cutoffs;
- large abnormal positions in active markets;
- wallets independently confirmed by trusted-wallet consensus.

Do not monitor every wallet at the same cadence.

### Polling tiers

```text
hot: active high-trust wallets and recent abnormal positions
warm: durable/category specialists
cold: sparse promising wallets and discovery candidates
```

A cold wallet can be polled slowly without being removed.

## Hierarchical skill model

Store metrics per:

```text
wallet
wallet × category
wallet × subcategory/league
wallet × market type
```

For each unique resolved campaign calculate:

```text
entryProbability = weighted average wallet fill
ourAllInPrice = executable copy price at detection
outcome = 0 or 1
walletProbabilityResidual = outcome - entryProbability
copyProbabilityResidual = outcome - ourAllInPrice
walletReturn = (outcome - entryProbability) / entryProbability
copyReturn = (outcome - ourAllInPrice) / ourAllInPrice
```

Then shrink category evidence toward global wallet evidence and platform/category priors.

Practical V1:

```text
categoryWeight = nCategory / (nCategory + 10)
globalWeight = nGlobal / (nGlobal + 20)

walletGlobalEdge = globalWeight × observedGlobalEdge
walletCategoryEdge =
  categoryWeight × observedCategoryEdge
  + (1 - categoryWeight) × walletGlobalEdge
```

Also calculate an uncertainty-adjusted edge:

```text
lowerEdge = posteriorEdge - uncertaintyPenalty
```

Do not use the lower bound as a hard gate for every candidate. Use it for sizing and ranking.

## Separate trust from capacity

Suggested output:

```ts
interface WalletCategorySignal {
  posteriorEdge: number;
  lowerEdge: number;
  resolvedCampaigns: number;
  signals30d: number;
  netRoi: number;
  maxDrawdown: number;
  copyAlpha10m: number;
  alphaHalfLifeSec: number;
  trustScore: number;
  capacityScore: number;
}
```

## Informed-like event overlay

Add an event-level score, not an “insider wallet” permanent label:

```ts
interface InformedLikeFeatures {
  sizeZ: number;
  convictionPct: number;
  preEventTimingScore: number;
  directionalConcentration: number;
  permanentPriceImpact: number;
  categorySpecificity: number;
  lifecycleAnomaly: number;
}
```

This directly implements the strongest public informed-trader findings: abnormal size, timing, profitability, and directional concentration.

## Expected impact

**Estimate, not verified forecast:**

- 2–5× more meaningfully evaluated wallet candidates than the current top-50 enrichment path;
- lower leaderboard churn;
- fewer one-hit false positives;
- preservation of rare specialists;
- higher non-sports signal frequency without lowering all categories to one global threshold.

The biggest immediate gain may be frequency rather than win-rate improvement.

## Live test

Shadow-log every candidate under two labels:

```text
currentGlobalAdmission
hierarchicalWalletCategoryAdmission
```

Compare after resolution:

- copy ROI;
- probability residual;
- win rate by entry-price bucket;
- drawdown;
- capital lock time;
- signals per week;
- missed profitable candidates.

Promote when the hierarchical system produces either:

- higher net ROI at similar frequency; or
- materially more trades with no meaningful degradation in payoff-weighted return.

## Lane B implementation started

Lane B now includes:

```bash
npm run research:wallet-universe
npm run research:wallet-universe -- --json
```

`src/research/walletUniverseAudit.ts` fetches explicit multi-horizon and category PnL leaderboards, deduplicates wallets, reports daily-only churn, and ranks repeated appearances for audit. Its persistence score is diagnostic only, not a production trust score.

---

# 6. Proposal 2 — Independent Consensus + Wallet Campaigns

## Rank

**#2 priority. Highest likely win-rate improvement.**

## Profit leak fixed

The bot treats one wallet fill as a complete signal. It does not distinguish:

- one initial thesis;
- ten split fills;
- same-wallet scale-in;
- independent confirmation;
- copycat confirmation;
- opposing informed flow;
- partial exit.

## Step 1: aggregate campaigns

For each wallet and token, merge fills into a campaign until a meaningful inactivity or direction-change boundary.

Starting heuristic:

```text
same wallet + same token + same direction + <=10 minutes apart = one campaign
```

Campaign fields:

```ts
interface WalletCampaign {
  wallet: string;
  tokenId: string;
  marketId: string;
  firstFillAt: Date;
  lastFillAt: Date;
  weightedEntry: number;
  grossSharesBought: number;
  grossSharesSold: number;
  netShares: number;
  grossNotional: number;
  maxSingleFillNotional: number;
  convictionVsWalletMedian: number;
  state: "entry" | "scale_in" | "reduction" | "exit";
}
```

This removes fake sample size and makes same-wallet conviction measurable.

## Step 2: rolling consensus window

Group active campaigns by token over 10-, 20-, and 30-minute windows.

Do not use raw count. Use effective independent weight:

```text
effectiveConsensus = Σ(
  walletCategoryTrust
  × campaignConviction
  × recencyDecay
  × independenceWeight
  × remainingEdgeWeight
)
```

Suggested recency:

```text
recencyDecay = exp(-ageSeconds / walletCategoryAlphaHalfLife)
```

If half-life is unknown, use a conservative category default.

## Step 3: independence graph

Build a soft graph. Two wallets receive lower independence when they show:

- common visible owner/profile association;
- direct funding transfers;
- same deposit/funder route where reliably observable;
- repeated same-token entries within a fixed lag;
- near-identical sizes and price sequences;
- unusually high event overlap;
- one wallet systematically following another.

Account-based Polygon wallets cannot use Bitcoin-style common-input clustering. Use transfer graphs, profile/proxy relationships, behavior, and timing. Never treat a soft cluster as proof of common ownership.

Simple V1:

```text
same hard entity cluster: independenceWeight = 0
same strong behavioral cluster: 0.25
moderate correlation: 0.50
unknown/independent: 1.00
```

Cap contribution per cluster so one entity cannot manufacture consensus.

## Step 4: consensus changes size, not binary admission

Recommended behavior:

```text
strong single specialist: exploratory or normal entry
second independent strong wallet: scale position
third independent wallet: scale again within event cap
opposing strong wallet: reduce rank or size
source-wallet material SELL: follow exit logic
```

This preserves alpha from rare single-wallet informed positions.

## Current Lane B gap

Lane B already contains a basic raw wallet count and consensus multiplier. It is a useful first step, but it currently counts wallets from fresh unscored observations or open positions without a strict rolling signal window, category-weighted trust, campaign aggregation, or independence penalty.

The next implementation should improve that existing mechanism rather than add another parallel consensus framework.

## Expected impact

**Directional expectation:**

- consensus subset should have higher win rate and lower drawdown;
- same-wallet scale-ins should improve conviction without pretending to be independent evidence;
- cluster penalties should prevent false confidence;
- opposing flow should reduce avoidable losses.

Do not forecast a precise improvement before live evidence. Use a promotion target:

```text
at least 50 resolved consensus candidates
and either +5 percentage points win rate
or +3 percentage points net ROI versus matched single-wallet entries
```

Matching should control for entry price, category, and resolution horizon.

---

# 7. Proposal 3 — Remaining-Edge Engine + Category Expansion

## Rank

**#3 priority. Highest trade-frequency expansion after wallet intelligence improves.**

## Profit leak fixed

Current gates mainly ask whether the market is structurally acceptable. They do not directly estimate the probability that the copied outcome wins after combining wallet skill, category specialization, campaign conviction, and consensus.

The economic decision is simpler:

```text
remainingProbabilityEdge = estimatedWinProbability - executableAllInPrice
```

For a $1 binary payout, expected profit per share is exactly that difference, before settlement-risk adjustments.

Expected return on cash:

```text
expectedRoi =
  (estimatedWinProbability - executableAllInPrice)
  / executableAllInPrice
```

## Probability estimate

Start lean. Do not build an oversized ML framework.

```text
logit(pWin) =
  logit(currentMarketPrice)
  + walletGlobalEdge
  + walletCategoryEdge
  + campaignConvictionAdjustment
  + consensusAdjustment
  + informedLikeAdjustment
  - latencyDecay
```

The market price remains the base prior. Wallet information only adjusts it.

Then use uncertainty:

```text
pConservative = pWin - uncertaintyBuffer
remainingEdge = pConservative - executableAllInPrice
```

Uncertain but coherent signals receive small size. Negative remaining edge receives no trade.

## Learn alpha half-life

For every wallet-category campaign record:

- source fill;
- first detection;
- executable quote;
- price after 30 seconds;
- 2 minutes;
- 10 minutes;
- 1 hour;
- final outcome.

Classify wallets:

```text
fast information wallet: edge disappears in seconds/minutes
slow research wallet: edge persists for hours/days
market mover: source trade itself shifts price
contrarian specialist: price may move against it before resolving correctly
```

Use this for execution:

- fast alpha → immediate taker execution with tight maximum price;
- slow alpha → maker-first or patient limit entry;
- market mover → detect before chasing; require remaining edge;
- contrarian → do not reject only because of a small adverse move if historical final edge remains strong.

## Category policy

Do not use one universal rule.

### Sports

- proven baseline;
- rapid signal decay;
- short capital lock;
- strong event-time structure;
- category/league specialization valuable.

### Politics/geopolitics

- potentially larger information asymmetry;
- slower resolution and capital lock;
- high value from event-level abnormality and timing;
- rank by edge per expected lock day, not win rate alone.

### Crypto

- external spot/perpetual markets absorb public information quickly;
- wallet signal may be less incremental;
- require strong category posterior, consensus, or measurable post-trade impact;
- shorter freshness windows.

### Culture/mentions/tech

- plausible nonpublic-information edge;
- resolution wording and source quality can dominate;
- abnormal new-wallet concentration can be valuable;
- require clear token/outcome mapping and resolution-source quality.

### Weather/economics/finance

- public-data modeling can compete with wallet skill;
- specialist wallets can still add value;
- compare copied wallet edge with direct model/market baseline where cheap.

## Expansion method

```text
sports proven: normal/full sizing
non-sports with strong wallet-category history: normal sizing
non-sports with strong independent consensus: normal or scaled sizing
new category with coherent single signal: exploratory sizing
unknown category with no evidence and poor remaining edge: skip
```

This increases frequency without weakening the sports core.

## Expected impact

**Estimate with high uncertainty:**

- non-sports could add 25–100% more raw candidate flow;
- accepted trades will be much lower after executable-edge ranking;
- capital lock may reduce bankroll turnover, especially politics;
- ranking by expected return per lock day is required to prevent nominal edge from reducing realized monthly PnL.

The objective is not category diversity. It is additional net dollars.

---

# 8. Recommended Wallet Score Architecture

Do not collapse everything into one opaque global number.

## Persistent wallet profile

```ts
interface WalletProfileV2 {
  wallet: string;
  resolvedCampaigns: number;
  posteriorGlobalEdge: number;
  globalNetRoi: number;
  maxDrawdown: number;
  worstDecileReturn: number;
  signals30d: number;
  medianNotional: number;
  medianCopyDeterioration: number;
  alphaHalfLifeSec: number | null;
  lastActiveAt: Date;
}
```

## Category profile

```ts
interface WalletCategoryProfile {
  wallet: string;
  category: string;
  subcategory: string | null;
  resolvedCampaigns: number;
  posteriorEdge: number;
  lowerEdge: number;
  netRoi: number;
  maxDrawdown: number;
  signals30d: number;
  medianCopyDeterioration: number;
  alphaHalfLifeSec: number | null;
}
```

## Event candidate

```ts
interface CopyCandidateV2 {
  campaignId: string;
  tokenId: string;
  walletTrust: number;
  categoryTrust: number;
  campaignConviction: number;
  informedLikeScore: number;
  effectiveConsensus: number;
  executableAllInPrice: number;
  estimatedWinProbability: number;
  conservativeWinProbability: number;
  remainingEdge: number;
  expectedRoi: number;
  expectedLockDays: number;
  expectedEdgePerLockDay: number;
  proposedSize: number;
}
```

## Capital ranking

Rank candidates by expected dollar contribution under capital constraints:

```text
rankValue =
  expectedRoi
  × fillProbability
  × riskMultiplier
  × urgencyMultiplier
  ÷ lockDurationPenalty
```

Then allocate from best to worst while keeping event, category, and correlated-entity concentration visible.

---

# 9. Research Findings Relevant to This Bot

## Actual alleged insider trading exists on Polymarket

Two 2026 U.S. Department of Justice cases are directly relevant:

- A Google employee was charged with using confidential internal data to profit approximately $1.2 million on Google-related Polymarket markets.
- A U.S. Army soldier was charged with using classified information about a military operation to profit more than $400,000 on Polymarket.

These cases establish that the insider hypothesis is not purely theoretical. They do not imply that most top wallets are insiders.

## Event-level detection is stronger than trader-level averages

Joshua Della Vedova's 2026 working paper argues that informed-trading identification must operate at the trader-event unit. Pooled wallet averages dilute episodic private information, while selecting a trader's best episode mechanically favors highly active traders.

This strongly supports:

```text
global wallet prior + event-level abnormality
```

rather than permanent insider labels.

## Public composite screens use the right variables

Mitts and Ofir's 2026 Polymarket study screens wallet-market pairs using:

- abnormal bet size;
- profitability;
- pre-event timing;
- directional concentration.

Those are suitable features for `informedLikeScore`.

## Skill and insider trading are different populations

Recent Polymarket research does not agree on one explanation for top profits:

- Some working papers find substantial anomalous/informed-like profit concentration.
- Akey, Grégoire, Harvie, and Martineau find that the top 1% capture most profits and that successful traders often provide liquidity; their evidence suggests insider trading is unlikely to explain the largest winners as a group.
- Luong and Heesen identify a thin layer of skilled traders whose execution-role behavior and price impact improve market accuracy.

Production implication:

> Do not equate PnL rank with insider status. Track persistent skill, execution skill, and event-level abnormality separately.

## Late entry inflates apparent win rate

Yang's 2026 analysis reports that top traders can appear extremely accurate because many entries occur near settlement. Skill measurement must control for price and timing.

This validates using probability residual, net ROI, and competitive-entry performance instead of raw win rate.

## Domain-specific skill matters

Yang's work also reports domain-specific skill validation. A globally profitable wallet can be unskilled outside its specialty. This directly supports wallet-category and wallet-subcategory posteriors.

## Wallet clustering must fit Polygon's account model

Bitcoin common-input ownership heuristics do not directly apply to Ethereum/Polygon account-based networks. Research on Ethereum and Polygon address clustering emphasizes transfer graphs, behavioral fingerprints, profile/ownership relationships, and graph representation learning.

For this bot, full graph ML is unnecessary initially. A conservative soft independence graph is sufficient to prevent obvious consensus double-counting.

---

# 10. Polymarket-Specific vs Universal

## Universal mechanism

These components transfer to Hyperliquid, Solana DEXes, and other on-chain venues:

- multi-horizon wallet discovery;
- hierarchical global/category/asset skill;
- event or position campaign aggregation;
- price-adjusted performance;
- Bayesian shrinkage;
- drawdown and tail-loss sizing;
- independent-wallet consensus;
- entity/copycat clustering;
- alpha half-life;
- remaining-edge calculation;
- candidate capital auction;
- follow-the-source reductions and exits.

## Polymarket-specific components

- binary $1 payout;
- market price as probability prior;
- favorite-longshot bias;
- outcome-token and condition IDs;
- Gamma/Data/CLOB API structure;
- proxy/Safe/deposit wallets;
- resolution-source and oracle risk;
- negative-risk event relationships;
- category-specific resolution timing;
- fee curve and CLOB depth;
- hold-to-resolution accounting.

## Hyperliquid adaptation

The wallet model transfers, but the trade model changes:

- continuous price rather than binary outcome;
- leverage and liquidation;
- funding payments;
- changing position delta;
- stop/exit behavior matters more than final resolution;
- copy delay can radically change risk-reward.

Use wallet-asset skill, position campaigns, leverage-adjusted drawdown, and remaining expected move after copy slippage.

## Solana DEX adaptation

The wallet model transfers, but trust must include:

- token contract risk;
- liquidity-pool depth;
- MEV and sandwich exposure;
- creator/insider wallet links;
- wallet rotation and sybil clusters;
- exit liquidity;
- no objective binary resolution.

The universal engine is not “copy every profitable wallet.” It is:

> identify repeatable wallet-context edge, confirm independence, estimate remaining executable edge, size it, and exit intelligently.

---

# 11. Implementation Order

## Step 0 — Fix universe observability

- Use explicit leaderboard horizons and categories.
- Run `research:wallet-universe` and measure overlap/churn.
- Keep current production admissions unchanged while collecting evidence.

## Step 1 — Create campaign-level history

- Aggregate fills by wallet-token campaign.
- Recompute resolved edge, ROI, category evidence, frequency, and drawdown on unique campaigns.
- Preserve raw fills for execution analysis.

## Step 2 — Shadow hierarchical scores

For every current candidate, record:

```text
current wallet global score
wallet global posterior edge
wallet-category posterior edge
informed-like score
campaign conviction
consensus raw count
effective independent consensus
estimated remaining edge
```

Do not gate production yet.

## Step 3 — Use scores for sizing first

- Keep the proven sports admission path.
- Increase/decrease paper size using category posterior, drawdown, consensus, and remaining edge.
- Avoid adding hard filters before payoff evidence.

## Step 4 — Expand discovery categories

- Admit small exploratory non-sports candidates with positive remaining edge.
- Scale only when wallet-category or independent-consensus evidence strengthens.

## Step 5 — Replace coarse global gates only after evidence

The global score can remain as a fallback prior. It should stop being the dominant binary gate after the hierarchical model has enough live observations.

---

# 12. Final Recommendations

## Build these three changes

1. **Multi-horizon/category wallet universe with hierarchical price-adjusted skill.**
2. **Campaign aggregation plus independence-weighted consensus.**
3. **Remaining-edge probability engine that controls category expansion and execution urgency.**

## Do not build these mistakes

- mandatory two-wallet consensus;
- permanent insider labels;
- raw win-rate rankings;
- one global wallet score for every category;
- frequency as a proxy for trust;
- drawdown as an automatic rejection;
- full graph neural-network clustering before simple heuristics are tested;
- category expansion without capital-lock accounting;
- more hard gates merely to improve headline win rate.

## Correct mental model

The index analogy is useful, but the bot should not copy an index mechanically.

A better analogy is:

> a continuously updated network of specialist portfolio managers, where every new position is judged by the manager's domain history, current conviction, independent corroboration, and the price still available to us.

The wallet universe is the discovery engine.

The **wallet-category-event campaign** is the signal.

The **remaining executable edge** is the trade.

The **capital-weighted realized PnL** is the only final score.

---

# Sources

## Repository

- `main/src/jobs/scanLeaderboard.ts`
- `main/src/adapters/leaderboard.ts`
- `main/src/jobs/scanWallets.ts`
- `main/src/lib/scoring.ts`
- `main/src/jobs/scoreTrades.ts`
- `main/src/jobs/monitorTrades.ts`
- `main/prisma/schema.prisma`

## Official Polymarket documentation

- Leaderboard API and defaults: https://docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings
- Data/API architecture: https://docs.polymarket.com/api-reference/introduction
- Public trades endpoint: https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets
- Closed positions endpoint: https://docs.polymarket.com/api-reference/core/get-closed-positions-for-a-user
- Wallet/proxy architecture: https://docs.polymarket.com/trading/overview
- Public profile: https://docs.polymarket.com/api-reference/profiles/get-public-profile-by-wallet-address
- On-chain data resources: https://docs.polymarket.com/resources/blockchain-data

## Informed trading and skill research

These are mostly 2026 working papers/preprints and should be treated as evidence, not settled fact.

- Joshua Della Vedova, “Detecting Informed Trading in Prediction Markets: One Event at a Time”: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6567238
- Joshua Mitts and Moran Ofir, “From Iran to Taylor Swift: Informed Trading in Prediction Markets”: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6426778
- Siyang Liu, “Wisdom of the Crowd or Wisdom of the Insider?”: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6678718
- Pat Akey, Vincent Grégoire, Nicolas Harvie, Charles Martineau, “Who Wins and Who Loses in Prediction Markets? Evidence from Polymarket”: https://cepr.org/index.php/publications/dp21615
- Kim Long Luong and Gloria Heesen, “The Wisdom of the Few: Skilled Traders and Prediction Market Accuracy”: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6758662
- Hsiang-Chieh Yang, “Skilled Liquidity Provision in Prediction Markets”: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6556613
- Hsiang-Chieh Yang, “Measuring Trader Skill in Prediction Markets: How Late Entry Inflates Forecasting Accuracy”: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7065625
- Maksym Nechepurenko, “Per-Market Information Leakage and Order-Flow Skill”: https://arxiv.org/abs/2605.02287

## Documented alleged insider cases

- U.S. DOJ, Google employee/Polymarket case: https://www.justice.gov/usao-sdny/pr/google-employee-charged-insider-trading
- U.S. DOJ, military-operation/Polymarket case: https://www.justice.gov/opa/pr/us-soldier-charged-using-classified-information-profit-prediction-market-bets

## Account-based wallet clustering

- Dario Thürkauf, “Address Clustering Heuristics for Account-Based Blockchain Networks”: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4589925
- Ferenc Béres et al., “Blockchain is Watching You: Profiling and Deanonymizing Ethereum Users”: https://arxiv.org/abs/2005.14051
- Jiajun Zhou et al., “Behavior-aware Account De-anonymization on Ethereum Interaction Graph”: https://arxiv.org/abs/2203.09360
