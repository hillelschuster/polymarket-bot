# Weather live execution lane — fastest path to realized PnL

Snapshot: **2026-08-13**

## Decision

Use this repository as the **first live execution bridge** for the demonstrated Polymarket Weather T+0 observation edge.

Do not wait for the design-only `hillelschuster/Polyrustbot` implementation before collecting real Weather fills/PnL.

The reason is economic:

- live `polymarket-weather` evidence measured an ordinary NOAA station-file source arriving about 211 seconds after nominal KLGA observation time;
- even after the source actually arrived, several central NYC Weather ladder sides stayed at old top-of-book levels for roughly 20–27 seconds;
- this repository already has authenticated V2 signing, FOK/batch execution, unwind logic and a live CLOB market WebSocket.

The fastest next dollar is therefore **reuse the current TypeScript execution primitives, remove avoidable hot-path REST/DB work, and improve the weather source**, not build a new Rust engine first.

## Existing reusable code

### `src/adapters/execution.ts`

Reuse:

- singleton authenticated V2 `ClobClient`;
- signer/credentials/funder/signature setup;
- exact order construction;
- FOK submission;
- batch submission;
- order/trade inspection;
- unwind concepts;
- tick/NegRisk order options.

Do **not** call the current `executeFokBuy()` unchanged from the Weather hot path because it fetches a fresh REST book and fee model before signing.

### `src/lib/realtimeOrderBook.ts`

Reuse initially:

- market `book` snapshots;
- `price_change` deltas;
- tick-size changes;
- in-memory per-token state;
- exact share-depth helper semantics.

Do not optimize its `Map<number, number>` plus sort/rebuild pattern yet. First measure whether it causes meaningful lost edge. The Weather live window is currently orders of magnitude larger than normal JS processing latency.

### `src/jobs/runRealtimeCalendar.ts`

Reuse concepts:

- public market WebSocket connection;
- dynamic subscriptions;
- reconnect;
- resident books;
- dependency mapping from updated token to affected opportunity.

Do **not** copy its live money path:

`WS opportunity -> REST book refresh -> DB risk query -> DB row -> sign/submit`

For Weather, all price/risk/fee state required to act must already be resident.

## Missing pieces for Weather

### 1. Weather source adapter

A small adapter should emit:

```text
WeatherObservation {
  station
  valid_time
  source_first_seen_monotonic
  temp/native_extreme
  raw/source_version
}
```

Initial priority is the fastest practical exact/near-exact station path. The NOAA station TXT used by the research collector remains a baseline, not the desired production trigger.

### 2. Weather event/ladder map

Slow startup/control plane may use Gamma/CLOB REST to resolve:

- event/condition IDs;
- all bucket markets;
- explicit YES and NO token IDs;
- tick/min-size;
- fee model;
- NegRisk metadata;
- resolver station/source/rule.

Never infer outcome side from `primary_token_id` / `secondary_token_id`. `polymarket-weather` already found a real NegRisk market where the secondary token was explicitly YES.

### 3. Subscribe both YES and NO books

The NYC Aug 12 live case produced its strongest immediate markout on complementary NO.

A Weather ladder process that maintains only YES state cannot choose the best expression of a probability change.

### 4. Resident fee/executable state

Load/refresh fee and execution metadata outside the signal path.

Add a resident execution function that accepts:

- current resident book generation;
- already-known fee/tick/NegRisk state;
- maximum all-in price/minimum net proceeds;
- exact desired size;
- TTL/model generation.

It should sign and submit directly without a fresh REST book query.

### 5. Maker GTC/GTD post-only execution

Current inspected code is FOK-centric.

Weather needs:

- post-only maker BUY/SELL;
- cancel one / cancel batch;
- quote replacement;
- quote generation/version so stale desired orders are not recreated;
- immediate cancellation on materially changed weather state.

The live evidence currently favors information-aware passive complementary liquidity when spreads are wide.

### 6. Authenticated user WebSocket

Use the Polymarket user channel as ordinary fast state for:

- order placement acknowledgement;
- order update/cancellation;
- partial/full fill;
- trade lifecycle.

REST order/trade endpoints remain for startup/reconnect reconciliation, not normal polling after every order.

### 7. Exchange order heartbeat/dead-man

Resting Weather maker orders require the exchange open-order heartbeat mechanism, distinct from the `PING` used to keep the market WebSocket alive.

### 8. Downstream journal

Persist after decisions/submission, not before.

For every decision/order/fill record enough to reconstruct real profitability:

- weather valid time;
- source first-seen;
- q before/after;
- book generation;
- decision time;
- sign timing;
- submit timing;
- placement/fill/cancel timestamps;
- maker/taker role;
- price/size/fee/rebate;
- short markouts;
- settlement/realized PnL.

## Minimal hot loop

```text
weather receive
-> update resolver-aligned running state
-> recompute affected q values
-> cancel bad maker quotes first
-> evaluate YES and NO executable/maker prices from resident books
-> choose best expected-dollar route
-> sign
-> submit
-> process user-stream state
-> journal async
```

No Gamma, Data API, database, disk or fresh order-book REST calls in this path.

## Initial strategy scope

Start only with **T+0 daily temperature extrema** where the exact source/station semantics are mapped.

For each event maintain:

- running high/low;
- current/next resolver threshold;
- remaining peak-window state;
- compact `q` vector or next-threshold hazard;
- all YES/NO books;
- own orders/inventory.

### Route by economic state

**Hard elimination**

A bucket becomes impossible. Cross only if real remaining price leaves enough net dollars; otherwise cancel/requote.

**Fresh probability redistribution**

Observation materially changes bucket probabilities. Prefer maker when spread is wide and expected fill-conditioned markout exceeds the urgency cost; cross only where actual immediate post-fee EV is larger.

**Quiet state**

Quote only where fair-value margin + expected rebate exceeds adverse selection.

## What not to build

Before first realized Weather PnL, do not add:

- a generic strategy plugin framework;
- a new database schema unless the current journal cannot store required evidence;
- a generalized weather service;
- a custom book engine;
- Rust IPC;
- dashboards;
- multi-city portfolio optimization;
- broad forecasting ML.

## Relationship to the other repositories

### `polymarket-weather`

Authoritative source for:

- resolver/source semantics;
- T+0/T+1 alpha research;
- calibration coefficients/model versions;
- historical/live evidence;
- probability and maker/taker economics.

### This repository

Temporary first production Weather money path.

Own:

- live source ingress needed by the strategy;
- live market/user streams;
- resident executable state;
- current orders/positions;
- maker/taker router;
- order signing/submission;
- realized execution evidence.

### `Polyrustbot`

Future shared execution engine once measured local latency/cancel/queue behavior shows a Rust migration would recover meaningful dollars.

## Rust migration evidence to collect here

Measure:

- source receive -> strategy q update;
- q update -> intent;
- intent -> signed order;
- sign -> request write;
- request write -> HTTP response;
- response -> user-stream placement/fill;
- cancel request -> observed cancellation;
- lost opportunity/adverse-selection dollars attributable to those stages.

Only port the lane when the recoverable execution dollars justify the migration.

## Bottom line

This repository already solves enough of Polymarket execution to reach real Weather fills faster than a ground-up Rust implementation.

The immediate objective is therefore:

> **make the existing TypeScript money path resident and maker-capable, connect the faster weather feed, and measure realized Weather PnL.**
