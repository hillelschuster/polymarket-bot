# DEEP AUDIT: Wallet-Copy Alpha Amplification

**Research update:** 2026-07-22  
**Base commit reviewed:** `6c0c5dd`  
**Mechanism:** profitable-wallet signal -> sports token BUY -> executable CLOB entry -> hold to resolution  
**Mandate:** generate more money without replacing the mechanism or building a research department.

---

## 1. EXECUTIVE DECISION

The mechanism should remain the main strategy. The best expansion is not a new prediction model. It is to extract more value from the same information source:

1. **Find more genuinely copyable sports wallets.**
2. **Detect their trades faster.**
3. **Confirm the wallet still owns the bet when we enter.**
4. **Measure how much of the wallet's remaining upside we can still capture.**
5. **Add capital when independent profitable wallets agree or the same wallet scales in.**
6. **Allocate more bankroll to the leagues, wallets and timing states that actually produce realized money.**

The most important new concept is **copyability**.

A wallet can be an excellent trader but a terrible wallet to copy if its edge is absorbed before our entry. Conversely, a merely good wallet whose signal remains profitable for five minutes can be an excellent source for us.

The correct primary metric is therefore not leaderboard score alone. It is:

> **What net return remains for us at our executable price after this wallet trades?**

### Recommended strategy separation

Do not mix materially different payoff mechanisms in one result set.

- **Lane A — Core Sports Wallet Copy:** current 0.60-0.80 entries, before the event is finished, hold to resolution.
- **Lane B — Post-Final Resolution-Lag Copy:** separate script and ledger; copy proven-wallet purchases after the sports feed says the event finished but before the market resolves.
- **Lane C — Adjacent Category Shadow Copy:** same wallet-copy rationale applied separately to short-duration weather markets; paper/shadow only until independently profitable.

Lane A receives almost all engineering attention now. Lane B is the best high-leverage extension. Lane C is optional and lower priority.

---

## 2. VERIFIED CURRENT EVIDENCE

| Metric | Current evidence |
|---|---:|
| Paper trades | 25 |
| Open / resolved | 23 / 2 |
| Unrealized PnL | +$93.34 |
| Deployed capital | ~$363 |
| ROI on deployed capital | +25.6% |
| Positive open marks | 15/23 (65%) |
| Best observed subcategory | ATP tennis: 73% positive marks, +$37.92 |
| Best observed wallet | `0x076daa87...`: 83% positive marks, +$35.34 |
| Observed wallet trades | 2,167 |
| Actual copies | 25 |

The current result is treated as evidence that wallet selection contains alpha. This document focuses only on increasing captured profit.

---

## 3. EXISTING HAND BRAKES — KEEP THESE FINDINGS

These findings from the combined audit remain valid and should be addressed before adding speculative strategy work.

| Priority | Existing leak | Profit consequence | Minimal direction |
|---:|---|---|---|
| 1 | Slow full pipeline before monitoring | Missed signals and worse entries | Fast monitor/score tier; slow research tier |
| 2 | Global score rejects profitable copied wallets | Proven sources blocked | Low discovery floor plus proven-copy bypass |
| 3 | Default leaderboard is OVERALL/DAY | Wrong wallet population | SPORTS DAY/WEEK/MONTH union |
| 4 | Raw sizing ignores wallet conviction and bankroll | Large bets on noise, small bets on conviction | Aggregate wallet notional and bankroll-aware sizing |
| 5 | Flat eight-position wallet cap | Best wallet blocked | Performance- and event-aware cap |
| 6 | Sports stop-loss contradicts hold-to-resolution | Temporary drawdowns become permanent losses | No price stop for Lane A sports copies |
| 7 | Entry gap checked before authoritative quote | Hidden execution deterioration | Recheck using executable all-in price |
| 8 | Unrelated scanners consume time and capital | Dilution of the working lane | Freeze calendar/politics development |
| 9 | ATP/WTA/ITF category fallback incomplete | Wrong age and price gates | Explicit league mapping |
| 10 | Maximum sports horizon declared but unused | Capital lockup | Enforce maximum time to resolution |
| 11 | Fee source not using `feeSchedule` | Incorrect PnL and entry cost | Use market-specific fee schedule |
| 12 | Wallet settlement inferred from end date | False wallet wins/losses | Use official closed positions or terminal settlement |

Two previous proposals need refinement:

### Do not simply replace a five-cent gap with a ten-cent gap

A fixed number of cents is not economically consistent. A ten-cent delay from 0.60 to 0.70 leaves substantial upside. A five-cent delay from 0.78 to 0.83 destroys the allowed trade.

Use **remaining-upside capture** instead.

### Do not treat a single trade fill as wallet conviction

One Data API trade can be a partial fill. Aggregate the same wallet's BUY fills in the same token over a short interval before comparing the notional with that wallet's normal bet size.

---

# PART I — STRENGTHEN LANE A: CORE SPORTS WALLET COPY

## INSIGHT 1 — Rank wallets by copyability, not only by their own PnL

### Hypothesis

The most profitable wallet for the bot is the wallet whose signal retains the largest amount of **remaining upside at our executable entry**, not necessarily the wallet with the highest personal PnL.

### Data / evidence

The Data API exposes wallet trade price, size, token, market and timestamp. The CLOB exposes the executable book. The current journal already stores the wallet price and our all-in entry. This permits a direct capture metric:

```text
remainingUpsideCapture = (1 - ourAllInPrice) / (1 - walletVWAP)
```

Examples:

| Wallet entry | Our entry | Remaining upside captured |
|---:|---:|---:|
| 0.65 | 0.75 | 71% |
| 0.70 | 0.77 | 77% |
| 0.75 | 0.80 | 80% |
| 0.77 | 0.82 | 78%, but rejected by 0.80 cap |

This directly measures how much of the original opportunity remains. It automatically handles different entry prices better than a flat cent-gap rule.

### Estimated ROI impact

**+3 to +10 percentage points of net ROI** if it removes wallets whose personal alpha cannot survive copying and allows lower-priced signals with economically acceptable remaining upside.

### Implementation complexity

**Very low:** one formula, one logged metric, one threshold. Use `capture >= 0.70` as the initial exploratory gate while preserving `allInPrice <= 0.80`.

### Confidence

**High.** This metric is mechanically tied to our payoff.

### Decision

Make copyability the first wallet-ranking tiebreaker. Do not loosen the entry gap blindly.

---

## INSIGHT 2 — Confirm the wallet still holds the position before copying

### Hypothesis

Some apparently fresh BUY signals are stale because the wallet has already reduced or closed the position by the time our loop sees the trade. Copying only trades the wallet still holds should remove false signals without changing the strategy.

### Data / evidence

Polymarket's public `GET /positions?user=` endpoint returns current token size, average price, initial value, current value, total bought and realized PnL. It can be queried only after a candidate passes cheap gates.

The present pipeline observes a historical trade but does not verify that the wallet remains exposed.

### Estimated ROI impact

**+2 to +8 percentage points of ROI**, mainly by eliminating copied trades whose source wallet already abandoned the thesis.

### Implementation complexity

**Low:** one candidate-only API call and one condition.

Initial rule:

```text
copy only if current wallet token size > 0
and current size is at least 70% of the newly observed aggregated BUY size
```

Do not require exact equality because the wallet may have held tokens before the observed fill.

### Confidence

**High.** A wallet that no longer owns the token is no longer giving an active long signal.

---

## INSIGHT 3 — Broad discovery, narrow monitoring

### Hypothesis

The bot can find substantially more profitable wallets without slowing execution by separating wallet discovery from active polling.

### Data / evidence

The official leaderboard supports `SPORTS` with `DAY`, `WEEK`, `MONTH` and `ALL` periods, 50 results per page. The current default call without parameters is `OVERALL / DAY`.

The Data API trade rate limit is 200 requests per 10 seconds. The current system does not need to poll 500 wallets continuously.

### Estimated ROI impact

- **Trade count:** +50% to +200%.
- **Net ROI:** +2 to +6 percentage points from a cleaner sports-specialist pool.

### Implementation complexity

**Low.** No new architecture.

Use three groups:

1. **Stable pool:** top SPORTS/WEEK and SPORTS/MONTH wallets.
2. **Rising pool:** top SPORTS/DAY wallets not already in the stable pool.
3. **Proven-copy pool:** any wallet whose copies remain profitable, regardless of current leaderboard rank.

Union may contain up to 150 wallets. Enrich all slowly; actively poll only the best 40-75 copyable wallets.

### Confidence

**High.** It corrects the current population mismatch and avoids latency growth.

---

## INSIGHT 4 — Use official closed positions to score wallet skill immediately

### Hypothesis

The bot can identify good sports wallets much faster and more accurately by using their official closed-position record instead of inferring resolution from the latest 20 trades and an end date.

### Data / evidence

`GET /closed-positions?user=` returns position-level `avgPrice`, `totalBought`, `realizedPnl`, token, outcome, slug and end date. It supports pagination. This is the exact realized result needed for wallet selection.

The current enrichment can classify a past-end-date market as resolved even when the market is not officially terminal. It also sees only the latest 20 trades.

### Estimated ROI impact

**+3 to +10 percentage points of ROI** through better wallet selection; likely **2x or more usable candidate wallets** because wallets no longer need to wait for our own copy sample to prove themselves.

### Implementation complexity

**Low to medium:** one adapter plus simple aggregation.

Do not build another weighted score. Use tiers:

- **Tier A:** SPORTS WEEK/MONTH presence, at least 10 unique closed sports markets, positive realized sports ROI.
- **Tier B:** leaderboard-qualified but fewer than 10 closed sports markets; exploratory size.
- **Tier C:** bypass wallet with at least three profitable resolved copies in our own ledger.

Once our copy record reaches five resolved trades, our realized copy ROI overrides the public tier.

### Confidence

**High.** Official realized positions are superior to open marks and date inference.

---

## INSIGHT 5 — First wallet enters; consensus increases size

### Hypothesis

When multiple independently profitable wallets buy the same token close together, the signal is stronger. But waiting for consensus before entering sacrifices price. The correct use of consensus is **add-on sizing**, not an entry gate.

### Data / evidence

The existing observed-trade table already contains wallet, token and timestamp. Persistent dedup currently discards later signals for the same market/token, losing information about agreement.

The market positions and holders endpoints can also confirm that multiple tracked wallets remain exposed, although timestamps should come from observed trades.

### Estimated ROI impact

- **Total PnL:** +10% to +40% through better concentration.
- **ROI:** +1 to +5 percentage points if consensus genuinely improves outcomes.

### Implementation complexity

**Low to medium:** alter dedup behavior from "discard" to "record confirmation and optionally add size."

Initial rule:

```text
first qualified wallet: base position
second independent qualified wallet within 10 min: add 50%
third independent qualified wallet within 10 min: add another 50%
maximum event exposure: 10% of bankroll
all add-ons must pass current CLOB price, spread and capture gates
```

### Confidence

**Medium.** The logic is strong; the magnitude must be measured from the existing 2,167 observed trades.

---

## INSIGHT 6 — Do not count copycat wallets as independent consensus

### Hypothesis

Some top wallets may follow each other or be controlled by the same operator. Treating them as independent votes would create false confidence.

### Data / evidence

A full Polygon ownership investigation is not required. Existing trade history can identify leader-follower behavior:

- same token and side;
- repeated entries within 30-120 seconds;
- one wallet consistently earlier;
- later wallet consistently pays a worse price.

If wallet B follows wallet A across five or more different events and A is first at least 80% of the time, B should belong to A's behavioral cluster for consensus counting.

### Estimated ROI impact

**+1 to +4 percentage points of ROI** by preventing accidental over-sizing on duplicated information.

### Implementation complexity

**Low:** one offline/periodic pairwise lead-lag calculation over already stored trades. No blockchain indexer.

### Confidence

**Medium-high.** Behavioral clustering directly addresses the independence problem.

---

## INSIGHT 7 — Aggregate wallet scale-ins as conviction

### Hypothesis

A wallet repeatedly adding to the same outcome within several minutes is a stronger conviction signal than one isolated fill. The current system treats partial fills and true scale-ins similarly and ignores both for sizing.

### Data / evidence

The trades endpoint exposes size and price, while the activity endpoint also exposes `usdcSize`. Multiple fills can share a transaction or arrive close together.

Use a rolling aggregate:

```text
walletTokenNotional10m = sum(size * price) for BUY fills in same token over 10 min
convictionRatio = walletTokenNotional10m / walletMedianSportsPositionNotional
```

The denominator should use completed or aggregated positions, not individual fills.

### Estimated ROI impact

- **Total PnL:** +10% to +30% by putting more money behind genuine conviction.
- **ROI:** 0 to +3 percentage points, depending on whether scale-ins predict better outcomes.

### Implementation complexity

**Low:** aggregate existing records and apply a bounded multiplier.

Initial multiplier:

| Conviction ratio | Size multiplier |
|---:|---:|
| <0.5x normal | 0.75x |
| 0.5x-1.5x | 1.0x |
| 1.5x-3.0x | 1.5x |
| >3.0x | 2.0x cap |

### Confidence

**Medium.** Bet size often contains information, but raw single-fill size is unreliable; aggregation is essential.

---

## INSIGHT 8 — Use game state to set the signal half-life

### Hypothesis

A blanket 20-minute sports window is too crude. A pregame opinion can remain valid for 20 minutes. An in-play signal can become stale after one pitch, break, point or score change.

### Data / evidence

Polymarket provides a public Sports WebSocket with slug, score, period, elapsed time, `live`, `ended`, status and `finished_timestamp`. It supports MLB and tennis states without authentication.

### Estimated ROI impact

**+2 to +6 percentage points of ROI** through fewer stale in-play copies, while preserving the broad pregame window.

### Implementation complexity

**Low to medium:** maintain current game-state map keyed by slug and tag each candidate.

Initial rule:

- **Scheduled / pregame:** maximum age 20 minutes.
- **In progress:** maximum age 5 minutes.
- **Finished:** reject from Lane A and evaluate only in Lane B.
- **Suspended, postponed, cancelled:** reject.

The executable capture gate remains authoritative. Sports-feed status is a timing classifier, not a source for predicting the winner.

### Confidence

**High** that state-aware freshness is better than one global age.

---

## INSIGHT 9 — Maker-first entry only when the signal is slow enough

### Hypothesis

For pregame signals with a meaningful spread, trying briefly to enter as maker can save the taker fee and part of the spread without materially sacrificing the wallet signal.

### Data / evidence

Polymarket supports post-only GTC/GTD orders. Makers pay no fee. Sports takers pay `0.03 * p * (1-p)` per share, and sports makers participate in a 25% rebate pool. A post-only order is rejected if it crosses the spread.

At 0.65-0.80, the taker fee alone costs approximately 0.60%-1.05% of cash deployed. Avoiding one cent of spread adds another roughly 1.25%-1.54% relative to token price.

### Estimated ROI impact

**+0.5 to +2 percentage points of ROI** across all trades, depending on fill rate. Do not assume rebate income; count it only when actually paid.

### Implementation complexity

**Medium but under one day:** one short execution branch.

Initial rule:

- only pregame;
- only when spread is at least two ticks;
- post-only at best bid plus one tick for 10-20 seconds;
- cancel and FOK at the executable ask if unfilled and the capture gate still passes;
- in-play always use immediate protected execution.

### Confidence

**High** on cost savings, **medium** on practical fill rate.

---

## INSIGHT 10 — League allocation should follow realized copy economics

### Hypothesis

The edge may be concentrated in specific leagues and formats. More capital should go where the existing copy mechanism produces the highest realized return per day of capital lockup.

### Data / evidence

The current book already indicates stronger ATP performance. Gamma exposes `sportsMarketType`, `gameId`, `eventStartTime`, tags and league metadata. The Sports WebSocket provides state and finish time.

The correct metric is not win rate alone:

```text
leagueScore = realized net PnL / average dollars locked / median hours locked
```

Use only unique events so several positions in one match do not fake independence.

### Estimated ROI impact

- **Total PnL:** +10% to +30% through better allocation.
- **ROI:** +1 to +4 percentage points.

### Implementation complexity

**Very low** after trade metadata is clean. One league multiplier.

Only activate a multiplier after at least ten resolved independent events in that league:

- positive and strongest league: 1.25x;
- neutral: 1.0x;
- negative: 0.75x or shadow-only.

### Confidence

**Medium.** Current ATP result is promising, but the multiplier must use resolved results.

---

## INSIGHT 11 — Increase capital utilization without abandoning hold-to-resolution

### Hypothesis

A 50% deployed-capital ceiling may unnecessarily suppress a short-duration sports strategy. More money can be earned by keeping more capital working while preserving event-level concentration limits.

### Data / evidence

MLB and tennis generally finish in hours, while formal resolution may add time. The current strategy does not require a large margin buffer because positions cannot lose more than cash invested.

### Estimated ROI impact

- **Total PnL:** +20% to +70% if qualified trades are currently skipped for lack of allocated capital.
- **ROI percentage:** approximately neutral unless the additional trades differ in quality.

### Implementation complexity

**Very low:** sizing constants only.

For a $200 pilot:

```text
normal exploratory trade: $5
proven wallet / normal conviction: $10
proven + consensus or high conviction: $15-$20
max one event: $20
max one wallet: performance-scaled, but no more than 30% of bankroll
max total deployed: $140 (70%)
reserve: $60 for new signals and operational flexibility
```

Do not solve capital scarcity with early selling yet. First use a reasonable reserve and event caps.

### Confidence

**Medium-high.** It increases absolute income without changing the edge.

---

## INSIGHT 12 — Preserve later signals instead of permanent market-token dedup

### Hypothesis

The current permanent dedup is correct for preventing accidental duplicate entries, but it also discards economically meaningful later information: wallet scale-ins and independent-wallet confirmation.

### Data / evidence

Later same-token signals can represent:

1. duplicate API records;
2. partial fills from the same order;
3. a real same-wallet scale-in;
4. independent multi-wallet consensus.

These should not have the same treatment.

### Estimated ROI impact

**+10% to +35% absolute PnL** if the best trades attract repeated informed capital. Expected ROI effect is **0 to +5 percentage points**.

### Implementation complexity

**Low to medium:** keep one position row, but record signal events and permit bounded add-ons.

Rules:

- same transaction hash: duplicate/partial fill aggregation, no new signal;
- same wallet and token within ten minutes: aggregate conviction;
- different independent wallet and same token within ten minutes: consensus add-on;
- always enforce total event exposure.

### Confidence

**Medium-high.** The existing dedup is visibly throwing away useful signal structure.

---

# PART II — SEPARATE LEVERAGED MECHANISMS

## LANE B — Post-final resolution-lag wallet copy

This is the strongest adjacent opportunity, but it must remain separate from Lane A because its economics are different.

## INSIGHT 13 — Copy proven wallets after the event is finished but before resolution

### Hypothesis

After a real-world sports result is final, the winning token may remain tradable below $1 until proposal and oracle resolution. Proven wallets buying the winner during this interval can provide confirmation of the correct rule interpretation. The trade offers small but rapid returns with low directional uncertainty.

### Data / evidence

- The public Sports WebSocket emits `ended: true` and `finished_timestamp`.
- Trading stops only when the market resolves.
- Polymarket's documented UMA flow includes a two-hour challenge period after a proposal; proposal delay may add more time.
- The public Market WebSocket emits `market_resolved`.

This creates a measurable interval:

```text
sports finished_timestamp -> first post-final wallet BUY -> market_resolved timestamp
```

The actual opportunity must be measured. Do not assume every market offers it.

Approximate sports taker economics:

| All-in area before fee | Approximate net return if token redeems at $1 |
|---:|---:|
| 0.970 | ~3.00% |
| 0.985 | ~1.48% |
| 0.995 | ~0.49% |

### Estimated ROI impact

**+0.5% to +3% net per filled trade**, potentially with capital recycled within several hours. Absolute income could be meaningful if these opportunities occur frequently.

### Implementation complexity

**Medium, separate script:** reuse wallet monitor, CLOB quote and settlement code; add Sports WebSocket state and a separate ledger/strategy tag.

Initial admission:

- event status is definitively finished, not suspended/postponed/cancelled;
- market is active and accepting orders;
- price is 0.95-0.995;
- at least two independent qualified wallets buy the same outcome after finish, or one Tier A wallet plus unambiguous official result;
- current order book can fill the exact budget;
- hold to formal resolution;
- never mix results or thresholds with Lane A.

### Confidence

**Medium/speculative.** The structural interval is documented; frequency, available depth and actual prices need logging.

### Practical next step

Shadow-log this lane first. Record every event's finish time, first qualifying post-final wallet trade, executable ask and resolved time. Ten to twenty observed opportunities are enough to determine whether it deserves capital.

---

## LANE C — Weather wallet-copy clone, shadow only

## INSIGHT 14 — Weather is the cleanest adjacent category for the same mechanism

### Hypothesis

Category-specialist wallets may also contain alpha in short-duration weather markets. The same mechanism can be cloned without changing its logic: category leaderboard -> specialist wallet -> executable token BUY -> hold to resolution.

### Data / evidence

The leaderboard supports the WEATHER category and DAY/WEEK/MONTH periods. Weather markets are fee-enabled with a 0.05 taker rate and 25% maker rebate allocation. Many resolve on a short schedule using specified official data sources.

Compared with alternatives:

- politics locks capital for too long;
- short-duration crypto is too sensitive to copy latency;
- weather offers relatively frequent, rule-based resolution.

### Estimated ROI impact

**Unknown.** Potentially adds a second stream of trades, but there is no current evidence that the wallet-selection edge transfers.

### Implementation complexity

**Low if implemented as a separate configuration/script**, but it should remain shadow-only until its own resolved record is positive.

### Confidence

**Speculative.** This is an expansion option, not a current priority.

### Decision

Do not mix weather into sports scoring. Run a separate wallet pool, ledger and result report only after Lane A speed/copyability improvements are complete.

---

# PART III — RESEARCH QUESTIONS WITH NEGATIVE OR LIMITED VALUE

## INSIGHT 15 — There is no meaningful fee-optimal entry zone

### Hypothesis tested

Entering nearer 0.80 might be materially better because the fee curve falls near probability extremes.

### Data / evidence

For sports, fee per share is:

```text
fee = shares * 0.03 * p * (1-p)
```

As a percentage of cash notional, the approximate fee is `0.03 * (1-p)`:

| Entry | Approximate taker fee as % of cash |
|---:|---:|
| 0.60 | 1.20% |
| 0.65 | 1.05% |
| 0.70 | 0.90% |
| 0.75 | 0.75% |
| 0.80 | 0.60% |

Moving from 0.65 to 0.80 saves only about 0.45 percentage points of cash while gross winning upside falls from 53.8% to 25%.

### Estimated ROI impact

**Near zero as a selection feature.** Fee savings are much smaller than changes in payoff and true win probability.

### Implementation complexity

None.

### Confidence

**High.** Do not change the price band because of fees. Use exact fees, but let wallet quality and remaining upside determine entries.

---

## INSIGHT 16 — A Polygon wallet-intelligence module is not the fastest path

### Hypothesis tested

Deep Polygon transaction analysis might reveal superior trade timing, common ownership or hidden wallet clusters.

### Data / evidence

Polymarket's CLOB matches orders offchain and settles matched trades on Polygon. The public Data API already exposes wallet trade/activity timestamps, token, side, price, size, transaction hash, positions and closed positions. These are the variables needed for copy selection.

Onchain data may help identify funding relationships, but proxy/deposit/safe wallet structures complicate ownership inference. It will also arrive no earlier than trade settlement and does not improve wallet-specific detection speed.

### Estimated ROI impact

**Low for the core strategy** relative to effort. Behavioral lead-lag clustering can capture most of the useful cluster information from existing data.

### Implementation complexity

A proper ownership/funding investigation is a new module and likely exceeds the one-day-value threshold.

### Confidence

**High.** Do not build a blockchain indexer now. Use Polygon only for a one-off manual check if one wallet cluster receives substantial real capital.

---

## INSIGHT 17 — Do not make consensus a hard entry requirement

### Hypothesis tested

Waiting for two or three wallets before entering might improve win rate.

### Data / evidence

Consensus necessarily arrives after the first informed trade. The mechanism is latency-sensitive, and the market may move while waiting. This sacrifices the best entry on the strongest signals.

### Estimated ROI impact

A hard consensus gate could **reduce total PnL and remaining-upside capture**, even if win rate rises.

### Implementation complexity

None; avoid this design.

### Confidence

**High.** Enter on the first qualified wallet and use later consensus for add-ons only.

---

## INSIGHT 18 — Default early exit is not the best capital-recycling solution

### Hypothesis tested

Selling a near-certain position at 0.92-0.98 could recycle capital before resolution.

### Data / evidence

Selling incurs a second taker fee and crosses the bid. The remaining payoff may still be attractive, and the current mechanism's edge is hold-to-resolution. Premature exits also contaminate the clean binary result record.

### Estimated ROI impact

Unknown and potentially negative. It should not be introduced while unused bankroll and a 70% deployment cap can solve most capital availability.

### Implementation complexity

A rational opportunity-cost exit requires comparing the old position's remaining net upside with the new queued signal. That is more complexity than currently justified.

### Confidence

**Medium-high.** Keep hold-to-resolution for Lane A. Revisit only when real capital is consistently 70% deployed and high-quality signals are being rejected for cash scarcity.

---

# PART IV — SIMPLE WALLET INTELLIGENCE THAT ACTUALLY MAKES MONEY

## The minimum wallet record

For every tracked wallet, maintain only these economically useful values:

1. SPORTS DAY/WEEK/MONTH leaderboard presence and rank.
2. Unique closed sports positions.
3. Realized sports PnL and ROI.
4. Median completed sports-position notional.
5. Our resolved copy PnL and ROI.
6. Median remaining-upside capture at our entry.
7. Median signal delay.
8. Leader/follower cluster ID.
9. Best and worst league by resolved copy economics.
10. Current active sports positions.

No opaque global formula is necessary.

## Wallet tiers

### Tier A — proven and copyable

- SPORTS WEEK or MONTH top 50;
- at least ten unique closed sports positions;
- positive realized sports ROI;
- median remaining-upside capture at least 70%, when measured;
- not a follower duplicate of another tracked wallet.

**Action:** $10 base; eligible for consensus/conviction scaling.

### Tier B — promising / insufficient history

- SPORTS DAY/WEEK/MONTH presence;
- positive public result but fewer than ten closed positions, or copyability not yet known.

**Action:** $5 exploratory positions.

### Tier C — proven directly by us

- at least three resolved copies;
- positive net copy PnL;
- at least 50% win rate;
- acceptable capture and no catastrophic loss.

**Action:** bypass weak leaderboard/global score; $10 base.

### Drop condition

Hard rejection should use **resolved** copy economics:

- at least five resolved copies and negative total copy PnL; or
- catastrophic resolved loss beyond the wallet limit.

Open marks can change size, but should not permanently remove a hold-to-resolution wallet.

---

# PART V — SIZING THAT REMAINS SIMPLE

For a $200 real-money pilot:

```text
base exploratory size = $5
Tier A or Tier C base size = $10
high conviction OR second independent wallet = +$5
high conviction AND consensus = up to $20
maximum one event = $20
maximum total deployed = $140
```

Do not use the generic market score for sizing after all binary gates pass.

Sizing inputs, in order:

1. wallet tier;
2. independent consensus count;
3. aggregated conviction ratio;
4. league multiplier after ten resolved events;
5. total/event exposure cap.

This is enough. Do not add Kelly optimization or a large weighting model.

---

# PART VI — PRIORITY: MAXIMUM MONEY PER HOUR OF DEVELOPMENT

## Phase 1 — Core capture, under one day

| Rank | Change | Expected effect | Complexity |
|---:|---|---|---|
| 1 | Fast 3-minute monitor/score tier; slow discovery tier | More trades, fresher prices | Small |
| 2 | SPORTS DAY/WEEK/MONTH union; narrow active shortlist | More qualified wallets without latency | Small |
| 3 | Candidate-only wallet position confirmation | Removes abandoned signals | Small |
| 4 | Remaining-upside capture gate and wallet metric | Directly improves copy profitability | Tiny |
| 5 | Official closed-position wallet tiers | Better wallet selection immediately | Small |
| 6 | Preserve later signals as conviction/consensus add-ons | More money on strongest bets | Small-medium |
| 7 | Disable Lane A sports stop-loss | Preserve hold-to-resolution edge | Tiny |
| 8 | Correct feeSchedule accounting | Accurate live economics | Small |

## Phase 2 — Execution and state

| Rank | Change | Expected effect | Complexity |
|---:|---|---|---|
| 9 | Sports WebSocket game-state tagging | Correct signal half-life | Small-medium |
| 10 | Maker-first pregame attempt with fast fallback | Lower costs | Medium |
| 11 | League capital multiplier | Concentrate in profitable subcategories | Tiny after data |
| 12 | Leader-follower behavioral clustering | Independent consensus | Small |

## Phase 3 — Separate leverage lane

| Rank | Change | Expected effect | Complexity |
|---:|---|---|---|
| 13 | Shadow post-final resolution-lag signals | Test 0.5%-3% short-duration trades | Medium, separate script |
| 14 | Deploy Lane B only after observed executable opportunities | New profit stream | Medium |
| 15 | Weather wallet-copy shadow lane | Adjacent category option | Low, separate stats |

---

# PART VII — GO / NO-GO FOR $200 LIVE PILOT

Move to the $200 real-money pilot when all are true:

- at least 30 post-current-logic resolved Lane A sports copies;
- realized net ROI after exact fees at least 8%;
- profitable after removing the three largest winners;
- positive capital-constrained $200 chronological replay;
- at least five wallets and ten independent trading days;
- no single wallet above 40% of total profit;
- maximum drawdown below 20%;
- no unresolved accounting mismatch between paper size, shares and executable costs.

Pilot sizing:

- $5 exploratory;
- $10 proven;
- $15-$20 only after consensus or strong normalized scale-in;
- $20 maximum per event;
- $140 maximum deployed;
- no further scaling until the first 30 real positions resolve.

---

# PART VIII — WHAT TO DO NEXT

The single best sequence is:

1. **Speed up the current copy lane.**
2. **Replace vague wallet quality with closed sports results and our copyability.**
3. **Verify the wallet still holds the token.**
4. **Enter the first qualified signal.**
5. **Add size when independent profitable wallets agree or the same wallet makes a true scale-in.**
6. **Allocate by resolved wallet/league economics.**
7. **Shadow the post-final resolution-lag lane separately.**

This produces more wallets, more clean bets, better filtering and more money on the sources already making money—without changing the core mechanism.

---

# OFFICIAL DATA SOURCES USED

- Polymarket trader leaderboard: <https://docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings>
- Public wallet/market trades: <https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets>
- Current wallet positions: <https://docs.polymarket.com/api-reference/core/get-current-positions-for-a-user>
- Closed wallet positions: <https://docs.polymarket.com/api-reference/core/get-closed-positions-for-a-user>
- Market positions: <https://docs.polymarket.com/api-reference/core/get-positions-for-a-market>
- Market holders: <https://docs.polymarket.com/api-reference/core/get-top-holders-for-markets>
- User activity: <https://docs.polymarket.com/api-reference/core/get-user-activity>
- Data/CLOB rate limits: <https://docs.polymarket.com/api-reference/rate-limits>
- Sports WebSocket: <https://docs.polymarket.com/market-data/websocket/sports>
- Market WebSocket: <https://docs.polymarket.com/market-data/websocket/market-channel>
- Market fields including `eventStartTime`, `sportsMarketType` and `feeSchedule`: <https://docs.polymarket.com/api-reference/markets/list-markets>
- Fees: <https://docs.polymarket.com/trading/fees>
- Maker rebates: <https://docs.polymarket.com/market-makers/maker-rebates>
- Order types and post-only behavior: <https://docs.polymarket.com/trading/orders/create>
- Resolution process and challenge period: <https://docs.polymarket.com/concepts/resolution>
- Historical batch price data: <https://docs.polymarket.com/api-reference/markets/get-batch-prices-history>

---

**Final thesis:** the next money does not come from predicting sports ourselves. It comes from identifying wallets whose information remains copyable, entering faster, and scaling only when the same information is independently confirmed.