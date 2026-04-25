# RPC Racer API

Production base URL: `https://evm.stupidtech.net`

## Overview

`evm.stupidtech.net` is a JSON-RPC proxy that races multiple public RPC providers and returns the first successful response.

- Races 10 random HTTPS RPC endpoints per request
- Falls back to Alchemy only when public RPC responses indicate likely state availability issues
- Caches chain metadata from Chainlist and Alchemy network config

## Endpoints

- `GET /`
  - Basic service metadata and route map.

- `GET /stats`
  - Returns service metrics as JSON.

- `POST /v1/:chain`
  - Proxies one JSON-RPC request.
  - `:chain` can be:
    - numeric chain ID (for example `1`, `8453`, `42161`)
    - chain alias (for example `ethereum`, `base`, `arbitrum`, `tempo`)
  - Query params:
    - `timeoutMs` (optional, integer `200`-`10000`, default `2000`)
    - `testnet` (optional, any present value enables testnet selection)

- `GET /v1/chains`
  - Lists cached chain entries.
  - Query params:
    - `includeRpcUrls` (optional, any present value includes full `rpcUrls` arrays)

- `GET /v1/chains/:chainId`
  - Returns one chain entry by numeric chain ID.

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

- `400`: invalid chain selector, query params, or JSON body
- `404`: unknown route or unknown chain
- `405`: method not allowed for endpoint
- `502`: no successful race result, or fallback conditions were not met, or fallback did not produce a result

## Contributing

1. Install dependencies: `bun install`
2. Run local dev server: `bun run dev`
3. Run checks before pushing: `bun run check`
4. Optional benchmark: `bun run benchmark`
5. Open a PR to `main`

Notes:

- Deployments run automatically on commits to `main` via GitHub Actions.
- Keep changes focused and include tests/verification steps in PR descriptions.
