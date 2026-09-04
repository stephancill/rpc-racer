# Implementation Notes — rpc-racer

Working notes for the `rpc-racer` Cloudflare Worker. Any implementation change
should be reflected here before committing.

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

</invoke>
