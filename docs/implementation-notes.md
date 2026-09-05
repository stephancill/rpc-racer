# Implementation Notes — rpc-racer

Working notes for the `rpc-racer` Cloudflare Worker. Any implementation change
should be reflected here before committing.

## 2026-09-05 — Make `/stats` durable by reading from Workers Analytics Engine

Root cause of the previous `/stats` undercount: the request counters lived only in
the `MetricsDurableObject`'s in-memory `liveCounters`, so they reset to zero every
time the `global` DO was evicted/recycled (every deploy + runtime churn), showing
only requests-since-last-reset. A durable source already existed — the Workers
Analytics Engine dataset (`rpc_racer_metrics`) — which persists across deploys.

### What changed

- **`/stats` now pulls from Analytics Engine** for its headline metrics over a
  rolling window (default 30 days, `STATS_WINDOW_DAYS`):
  `requestsServed`, `publicRequests`, `internalRequests`, `fallbackResponses`,
  `averageLatencyMs`, `latencyMaxMs`, `latencyBuckets`. The response carries an
  explicit disclaimer: window bounds (`windowStart`/`windowEnd`) plus a `note`
  clarifying the totals are for the rolling window, not the service's lifetime.
- Aggregation is a **single Analytics read query** (`POST /analytics_engine/sql`),
  reconstructed for true counts/latency by multiplying each row's telemetry sample
  weight (`double3`, =10 for the 10%-sampled successes, 1 for failures/429/fallback)
  by Analytics Engine's `_sample_interval` (adaptive read/write sampling).
- **Fallback**: if `CF_ACCOUNT_ID`/`ANALYTICS_TOKEN` aren't configured or the read
  fails, `/stats` degrades to the legacy in-memory DO snapshot (so it keeps working
  before the token is set).
- **Config**: `CF_ACCOUNT_ID` is a var in `wrangler.toml`; `ANALYTICS_TOKEN`
  (permission *Account Analytics → Read*) must be set with
  `wrangler secret put ANALYTICS_TOKEN`. Without it `/stats` uses the fallback.
- **Caching**: per-isolate 60s TTL to bound Analytics read query usage (each read
  query counts against the Analytics Engine quote).

### Behavior / breaking change

- The per-chain/per-method latency breakdown (`chainMethodLatencies`) was dropped
  (headline metrics only). README updated. Consumers of the old `/stats` shape
  should switch to the new fields.

### Verified

- `bun run lint`, `bunx oxfmt --write` pass; `bunx tsc --noEmit` shows only the two
  pre-existing `CacheStorage.default` errors.
- The exact aggregation SQL was exercised against the live
  `rpc_racer_metrics` dataset with a read token.

## 2026-09-04 — Migrate per-request metrics to Analytics Engine + coalesced DO writes

Approved under `address-notifications/docs/handover.md → Approved cost-reduction
work` (item 1). RPC request metrics were held entirely in the `MetricsDurableObject`:
counters and provider-health were persisted with **one DO storage write per
request**, and latency samples were appended one key-write at a time. At ~2.17M
requests/48h this dominated projected Durable-Object storage cost (≈6.4M rows
written/48h → ~95M/month on top of the 50M/mo allowance).

### What changed

- **`wrangler.toml`**: added a Workers Analytics Engine dataset binding
  (`METRICS_ANALYTICS` → dataset `rpc_racer_metrics`).
- **`src/index.ts`**:
  - `Env` gains `METRICS_ANALYTICS?: AnalyticsEngineDataset`.
  - `recordRpcMetrics` (per-request DO POST) is replaced by
    `recordRequestTelemetry()` + `rpcOutcome()`. Every request now:
    1. Writes **one Analytics Engine data point** (fire-and-forget) with caller,
       chain, method, outcome, provider (or `alchemy` when a fallback ran),
       latency, and a `sample_weight` double. Ordinary successes are sampled at
       `SUCCESS_SAMPLE_RATE = 0.1`; errors, rate-limits (429), and fallback
       responses are always written.
    2. Accumulates counter metrics + latency samples into a **per-isolate in-memory
       `StatsDelta` buffer**.
  - `scheduleCoalescedStatsFlush()` / `flushCoalescedStats()` push the buffered
    delta to `METRICS_DO` `/coalesce` on a debounce (`STATS_FLUSH_INTERVAL_MS =
15s`), collapsing storage writes from one/request to ~one per isolate window.
  - The old `caller` label that was sent to the DO but never persisted/returned is
    no longer sent; `caller` now actually lands in the Analytics Engine dimensions
    (`public`/`internal`), which is what makes scanner-vs-public cost attribution
    possible.
- **`MetricsDurableObject`**:
  - Added `POST /coalesce`, which merges a `StatsDelta` in one counters write per
    flush plus batched latency-sample appends and merged provider health. The
    legacy per-request `POST /record` handler is retained for compatibility but is
    no longer called.
  - Provider-health (`recordRpcHealth`) and block-speed state remain in the DO but
    are now driven by the coalesced health deltas, not one write per request.

### Behavior

- `/stats` (and the JSON `/`) stream stays populated with a bounded rolling
  counter + per-chain/method latency summary, now fed by coalesced deltas (up to a
  few seconds of staleness).
- Operator heavy-dimension analytics (caller, chain, method, outcome, provider)
  come from Analytics Engine; counters need `request_weight` scaling for the
  10% success sample.

### Verified

- `bunx tsc --noEmit` (only two pre-existing `CacheStorage.default` errors remain,
  unrelated), `bun run lint`, `bun run format`.
- The address-notifications bound-RPC / batch tests exercise the service-binding
  transport and the new range prefetch (see that repo's notes).

### Notes / follow-ups

- Analytics Engine billing is documented (not yet charged): 10M writes/mo included,
  then $0.25/M; at current volume with 10% success sampling we stay inside.
- A 24–48h post-deploy compare against the DO `rowsWritten` account metric should
  confirm ≥95% drop in metrics-DO storage writes.

### 2026-09-04 (follow-up): tighten coalesced DO writes

Post-deploy measurement showed metrics-DO `rowsWritten` ≈ 1/6 of the pre-fix rate
(~85% down) but slightly short of the 95% target. The residual writes are the
coalesced counter write, latency-sample backup writes, and provider-health /
block-speed store, which scale with flush cadence rather than request rate.
Tightened:

- `STATS_FLUSH_INTERVAL_MS` 15s → **60s** (4× fewer coalesce POSTs / DO writes).
- Added `MAX_LATENCY_SAMPLES_PER_METHOD_PER_WINDOW = 100`, capping the latency
  samples buffered per `(chain, method)` in a flush so a per-method burst can't
  drive N sample writes to the DO. `/stats` percentiles stay valid from the
  bounded sample set.
- **Provider-health persistence (2026-09-04)**: rewrote `MetricsDurableObject.recordRpcHealth`
  so only partial-failure/active-cooldown entries are persisted, and a change is
  written only when actual state changes. Previously every `/coalesce` with any
  `urlResults` rewrote the full health map (incl. healthy endpoints), which was
  the remaining downstream of the metrics-DO `rowsWritten` and the biggest block
  to the ≥95% write-reduction target. Cooldown semantics (2-failure threshold,
  5-min sliding window, immediate recovery on success) are preserved.
- **In-memory counters/samples (2026-09-04)**: `MetricsDurableObject` now keeps
  the request counters and per-chain/method latency samples **in memory only**
  (`liveCounters` / `liveSamples`) and no longer writes them (or their old
  per-(chain,method) sample keys) to DO storage. `/coalesce` and `/record` only
  mutate in-memory state; storage is touched only for provider-health and
  block-speed, which are already transition-bounded. `/stats` reads the live
  snapshot. Trade-off: if the `global` DO is ever evicted the rolling `/stats`
  summary resets — acceptable for a bounded live dashboard.

</invoke>
