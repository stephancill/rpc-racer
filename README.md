# RPC Racer API

Production base URL: `https://evm.stupidtech.net`

## Overview

`evm.stupidtech.net` is a JSON-RPC proxy that races multiple public RPC providers and returns the first successful response.

- Races 5 random HTTPS RPC endpoints per request
- Falls back to Alchemy only when public RPC responses indicate likely state availability issues
- Caches chain metadata from Chainlist and Alchemy network config

## Endpoints

- `GET /`
  - Basic service metadata and route map.

- `GET /stats`
  - Returns service metrics as JSON, including average and median latency for the last 1000 requests per method per chain.

- `POST /v1/:chain`
  - Proxies one JSON-RPC request.
  - Rate limited per source IP to 60 requests per 10 seconds and 60 requests per minute.
  - `:chain` can be:
    - numeric chain ID (for example `1`, `8453`, `42161`)
    - chain alias (for example `ethereum`, `base`, `arbitrum`, `tempo`)
  - Query params:
    - `timeoutMs` (optional, integer `200`-`10000`, default `2000`)
    - `fanoutCount` (optional, integer `1`-`5`, default `5`) — how many random
      upstreams to race per request. Lower it (e.g. `2`) to reduce request
      amplification for sustained scanner/monitor traffic.
    - `testnet` (optional, any present value enables testnet selection)

- `POST /internal/v1/:chain`
  - Same JSON-RPC proxy as `/v1/:chain`, but **exempt from the public
    per-IP rate limit** for service-bound callers.
  - Requires a matching `x-internal-secret` request header equal to the
    `INTERNAL_SECRET` secret (otherwise `401`).
  - Requests are recorded in metrics with `caller: "internal"` so scanner load
    can be observed separately from public traffic.

- `GET /v1/chains`
  - Lists cached chain entries.
  - Query params:
    - `includeRpcUrls` (optional, any present value includes full `rpcUrls` arrays)
  - Each entry may include `blockSpeedMs`, the estimated average time between blocks in milliseconds. Values are computed lazily (only for chains that don't yet have one) during refreshes, so the field appears once a chain has been sampled.

- `GET /v1/chains/:chainId`
  - Returns one chain entry by numeric chain ID. Includes `blockSpeedMs` when available.

## Block Speed

`blockSpeedMs` is an estimated average block interval for a chain, measured by probing the chain's own RPCs: `eth_blockNumber` followed by a few historical `eth_getBlockByNumber` reads, then dividing the timestamp span by the block count.

- Computed only for chains that do not yet have a stored value.
- A chain is probed via its own public RPCs first, then (if any API key is configured) via that chain's Alchemy endpoint as a reliable fallback.
- Chains whose sources don't respond are marked attempted; failed chains are retried after a cooldown, so they can be picked up later without busy-looping on dead endpoints. Such chains simply won't have a `blockSpeedMs`. The listing reports `covered` (the number of chains with a stored value) alongside `total`.
- Persisted in the `MetricsDurableObject` (survives across requests/refreshes).
- Sampling runs in the background (`ctx.waitUntil`) during `/v1/chains` refreshes, with a small number of chains estimated per pass, so the full set fills in over time.
- Reported in **milliseconds**.
- `scripts/fill-block-speeds.mjs` drives the refresh to completion (it polls `/v1/chains` and exits once coverage stops growing — remaining chains have no usable public RPC).

## Chain Selection

For `POST /v1/:chain` when `:chain` is a name/alias:

- default: selects the first non-testnet match
- with `?testnet`: selects the first testnet match

## Request Format

`POST /v1/:chain` expects a JSON-RPC 2.0 request body.

Example:

```json
{
  "jsonrpc": "2.0",
  "method": "eth_blockNumber",
  "params": [],
  "id": 1
}
```

## Response Headers

- `x-rpc-provider`: hostname of winning upstream provider
- `x-rpc-upstream`: full winning upstream URL
- `x-rpc-chain-id`: resolved chain ID
- `x-rpc-chain-name`: resolved chain name
- `x-rpc-fallback`: present with value `alchemy` when fallback was used
- `x-rpc-alchemy-attempted`: present on upstream error responses with whether Alchemy fallback was attempted

When every public RPC returns an error, the first valid JSON-RPC error body and its HTTP status are returned unchanged. Alchemy is attempted first only for likely state-availability errors.

## Example Calls

Mainnet by chain ID:

```bash
curl -sS "https://evm.stupidtech.net/v1/1?timeoutMs=2000" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

Mainnet by alias:

```bash
curl -sS "https://evm.stupidtech.net/v1/ethereum?timeoutMs=2000" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

Testnet selection by alias:

```bash
curl -sS "https://evm.stupidtech.net/v1/ethereum?testnet=1" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
```

List chains:

```bash
curl -sS "https://evm.stupidtech.net/v1/chains"
```

## Error Semantics

- `400`: invalid chain selector, query params, JSON body, or an upstream JSON-RPC error using HTTP 400
- `404`: unknown route or unknown chain
- `405`: method not allowed for endpoint
- `429`: rate limit exceeded; includes a `Retry-After` header. Contact `hi@stupidtech.net` if you need higher rate limits.
- `502`: no successful race result, or fallback conditions were not met, or fallback did not produce a result

## Contributing

1. Install dependencies: `bun install`
2. Run local dev server: `bun run dev`
3. Run checks before pushing: `bun run check`
4. Optional benchmark: `bun run benchmark`
5. Consistency integration test (Milestone 0): set `INTERNAL_SECRET` and run
   `bun run integration -- --fan-out 1 [--burst 5]` — verifies `eth_getLogs` by
   exact block hash is consistent and receipt hashes match across Ethereum,
   Base, Optimism, and Arbitrum.
6. Open a PR to `main`

Notes:

- Deployments run automatically on commits to `main` via GitHub Actions.
- Keep changes focused and include tests/verification steps in PR descriptions.
