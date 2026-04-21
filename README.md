# RPC Racer Worker

Cloudflare Worker that receives one JSON-RPC request and races multiple Chainlist RPC endpoints for a given chain ID.

Production URL: `https://rpc.steer.fun`

## URL format

- `POST /v1/:chainId`
  - Examples:
    - Ethereum: `/v1/1`
    - Base: `/v1/8453`
- Optional query params:
  - `max` (1-25): max number of RPC URLs to race (default `8`)
  - `timeoutMs` (200-10000): timeout per endpoint (default `2000`)

## Example

```bash
curl -sS "http://127.0.0.1:8787/v1/1?max=10&timeoutMs=3000" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

Example against production:

```bash
curl -sS "https://rpc.steer.fun/v1/8453?max=8&timeoutMs=2000" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

## Response headers

- `x-rpc-provider`: hostname of winning provider
- `x-rpc-upstream`: full upstream URL used
- `x-rpc-chain-id`: chain ID requested
- `x-rpc-chain-name`: human-readable chain name
- `x-rpc-fallback`: set to `alchemy` when fallback was used

## Chain source + refresh

- Source: `https://chainlist.org/rpcs.json`
- Refresh cadence: every 24 hours using cache TTL (`86400s`) plus in-memory cache.
- Alchemy network source (for fallback chain-ID mapping): `https://app-api.alchemy.com/trpc/config.getNetworkConfig`
- Alchemy config refresh cadence: every 24 hours using the same cache strategy.

## Fallback behavior

- If all raced endpoints fail, the worker tries one Alchemy RPC endpoint for the same chain.
- Set your API key as a Worker secret:

```bash
bunx wrangler secret put ALCHEMY_API_KEY
```

- Fallback chain support is discovered dynamically from Alchemy config by `networkChainId` -> `kebabCaseId`, so no hardcoded chain list.

## Run

```bash
bun install
bun run dev
```

## Deploy

```bash
bun run deploy
```

## GitHub Actions deployment

This repo includes `.github/workflows/deploy.yml`, which deploys on every commit to `main`.

Required repository secrets:

- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Workers edit permissions
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID for this worker
