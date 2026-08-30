#!/usr/bin/env bun

// Estimates average block time for every chain served by the API by reading the
// last N blocks through the evm.stupidtech.net proxy and averaging the
// difference between consecutive block timestamps.
//
// Requests are paced (default 1100ms apart) to stay within the proxy's per-IP
// rate limits (60 sustained/min, 60 burst/10s). Running every chain therefore
// takes roughly (blocks * paceMs) per chain, so prefer --chain-ids for targeted
// runs.
//
// Usage:
//   bun scripts/block-speed.mjs [--base-url ...] [--blocks 30] [--stride 10]
//     [--chain-ids 1,8453] [--timeout-ms 2000] [--pace-ms 1100]
//     [--retries 5] [--json out.json]

const DEFAULT_BASE_URL = "https://evm.stupidtech.net";
const DEFAULT_BLOCKS = 30;
const DEFAULT_STRIDE = 10;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_PACE_MS = 1100;
const DEFAULT_RETRIES = 5;

const args = parseArgs({ argv: process.argv.slice(2) });
const baseUrl = (args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const blocks = args.blocks ?? DEFAULT_BLOCKS;
const stride = args.stride ?? DEFAULT_STRIDE;
const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
const paceMs = args.paceMs ?? DEFAULT_PACE_MS;
const retries = args.retries ?? DEFAULT_RETRIES;

const chainFilter = args.chainIds;

// Global pacing slot: serializes every proxy call so no two are in flight and
// spacing is enforced by the sustained-limit period (see `pace`).
let nextSlotAt = 0;

console.log(
  `Estimating block times via ${baseUrl} ` +
    `(samples=${blocks}, stride=${stride}, timeoutMs=${timeoutMs}, paceMs=${paceMs}, retries=${retries})`,
);

const registry = await fetchChainRegistry({ baseUrl });
let chains = registry.chains;
if (chainFilter !== undefined) {
  const wanted = new Set(chainFilter);
  chains = chains.filter((chain) => wanted.has(chain.chainId));
  console.log(`Filtered to ${chains.length} of ${registry.total} chains by --chain-ids.`);
} else {
  console.log(`Scanning ${chains.length} of ${registry.total} chains sequentially ...`);
}

const startedAt = performance.now();
const results = [];
for (const chain of chains) {
  try {
    const estimate = await estimateChainBlockTime({
      baseUrl,
      chain,
      blocks,
      stride,
      timeoutMs,
      retries,
    });
    results.push({ chainId: chain.chainId, name: chain.name, ...estimate, error: null });
  } catch (error) {
    results.push({
      chainId: chain.chainId,
      name: chain.name,
      averageSeconds: Number.NaN,
      minSeconds: Number.NaN,
      maxSeconds: Number.NaN,
      sampleCount: 0,
      provider: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
const elapsedSeconds = ((performance.now() - startedAt) / 1000).toFixed(1);

printTable({
  title: `Block Time Estimate (avg across sampled history), ${elapsedSeconds}s)`,
  rows: results.map((result) => ({
    Chain: result.name,
    ChainId: result.chainId,
    AvgS: formatSeconds({ value: result.averageSeconds }),
    MinS: formatSeconds({ value: result.minSeconds }),
    MaxS: formatSeconds({ value: result.maxSeconds }),
    Samples: result.sampleCount,
    Provider: result.provider ?? result.error ?? "-",
  })),
});

const failed = results.filter((result) => result.error !== null);
if (failed.length > 0) {
  console.log(
    `\nCould not estimate ${failed.length}/${results.length} chains (${failed
      .slice(0, 10)
      .map((result) => result.chainId)
      .join(", ")}${failed.length > 10 ? ", ..." : ""}).`,
  );
}

if (args.json !== undefined) {
  const output = results.map((result) => ({
    chainId: result.chainId,
    name: result.name,
    averageSeconds: result.averageSeconds,
    minSeconds: result.minSeconds,
    maxSeconds: result.maxSeconds,
    sampleCount: result.sampleCount,
    provider: result.provider,
    error: result.error,
  }));
  await Bun.write(args.json, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\nWrote ${args.json}`);
}

async function fetchChainRegistry({ baseUrl }) {
  const response = await fetch(`${baseUrl}/v1/chains`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch chain registry: ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload?.chains)) {
    throw new Error("Chain registry payload missing chains array");
  }
  return payload;
}

async function estimateChainBlockTime({ baseUrl, chain, blocks, stride, timeoutMs, retries }) {
  const latestResult = await proxiedRpc({
    baseUrl,
    chainId: chain.chainId,
    method: "eth_blockNumber",
    params: [],
    timeoutMs,
    retries,
  });
  const latestHex = latestResult.result;
  if (typeof latestHex !== "string") {
    throw new Error("bad eth_blockNumber result");
  }
  const latestHeight = hexToBigInt(latestHex);

  // Sample `blocks` heights spread across history, `stride` blocks apart. The
  // newest head blocks are noisy (timestamps cluster at "now"), so looking back
  // over a wide window and averaging the whole span gives a stable per-block
  // time. Only spans_height total block heights are covered, so per-sample
  // requests are unchanged from the consecutive approach.
  const heights = [];
  for (let index = 0; index < blocks; index += 1) {
    heights.push(latestHeight - BigInt(index) * BigInt(stride));
  }

  const timestamps = [];
  for (const height of heights) {
    const block = await proxiedRpc({
      baseUrl,
      chainId: chain.chainId,
      method: "eth_getBlockByNumber",
      params: [bigIntToHex(height), false],
      timeoutMs,
      retries,
    });
    const raw =
      typeof block?.result === "object" && block.result !== null
        ? block.result.timestamp
        : undefined;
    if (typeof raw === "string") {
      try {
        timestamps.push(Number(hexToBigInt(raw)));
      } catch {
        // ignore unparseable timestamp
      }
    }
  }

  if (timestamps.length < 2) {
    throw new Error("insufficient block timestamps");
  }

  // heights/timestamps are recorded newest-first (descending height). Re-align
  // valid observations and average per-block time over the whole historical
  // span. `newest` is the highest block (observations[0]), `oldest` the lowest.
  const observations = heights
    .map((height, index) => ({ height, timestamp: timestamps[index] }))
    .filter((entry) => Number.isFinite(entry.timestamp));
  const newest = observations[0];
  const oldest = observations[observations.length - 1];
  const spanSeconds = newest.timestamp - oldest.timestamp;
  const spanBlocks = newest.height - oldest.height; // actual blocks spanned, no /stride

  if (spanSeconds <= 0 || spanBlocks <= 0n) {
    throw new Error("non-positive block time span");
  }

  return {
    averageSeconds: spanSeconds / Number(spanBlocks),
    minSeconds: minOrMaxDeltaSeconds({ observations, stride, takeMax: false }),
    maxSeconds: minOrMaxDeltaSeconds({ observations, stride, takeMax: true }),
    sampleCount: timestamps.length,
    provider: latestResult._provider ?? null,
  };
}

// Per-block time between consecutive observed samples: the timestamp delta over
// the block-height gap (converted back from the sampling stride). Returns the
// fastest (min) or slowest (max) observed sub-span for a sense of variance.
function minOrMaxDeltaSeconds({ observations, stride, takeMax }) {
  let best = null;
  for (let index = 1; index < observations.length; index += 1) {
    const gapBlocks = observations[index - 1].height - observations[index].height;
    const deltaS = observations[index - 1].timestamp - observations[index].timestamp;
    const perBlock = deltaS / Number(gapBlocks);
    if (best === null || (takeMax ? perBlock > best : perBlock < best)) {
      best = perBlock;
    }
  }
  return best ?? Number.NaN;
}

async function proxiedRpc({ baseUrl, chainId, method, params, timeoutMs, retries }) {
  let lastError = new Error("rate limited");
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await pace();
    const response = await fetch(`${baseUrl}/v1/${chainId}?timeoutMs=${timeoutMs}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: "block-speed" }),
    });

    if (response.status === 429) {
      const retryAfterSeconds = Number.parseInt(response.headers.get("retry-after") ?? "60", 10);
      lastError = new Error(`rate limited (retry-after ${retryAfterSeconds}s)`);
      await sleep(retryAfterSeconds * 1000);
      continue;
    }

    if (!response.ok) {
      lastError = new Error(`HTTP ${response.status}`);
      await sleep(500);
      continue;
    }

    const payload = await response.json();
    if (payload?.error !== undefined) {
      lastError = new Error(`RPC error: ${JSON.stringify(payload.error)}`);
      await sleep(500);
      continue;
    }

    return { ...payload, _provider: response.headers.get("x-rpc-provider") };
  }
  throw lastError;
}

// ---- rate limiting ----------------------------------------------------------
//
// Global pacing: serializes every proxy call so never more than one request is
// in flight, spaced by the sustained-limit period (the binding constraint vs.
// the burst limit). This keeps us under 60 sustained/min and 60 burst/10s.

async function pace() {
  const now = Date.now();
  const delay = Math.max(0, nextSlotAt - now);
  if (delay > 0) {
    await sleep(delay);
  }
  nextSlotAt = Math.max(Date.now(), nextSlotAt) + paceMs;
}

// ---- helpers ----------------------------------------------------------------

function hexToBigInt(value) {
  if (!value.startsWith("0x")) {
    throw new Error(`not a hex quantity: ${value}`);
  }
  return BigInt(value);
}

function bigIntToHex(value) {
  return `0x${value.toString(16)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs({ argv }) {
  const output = {};
  const intFlags = new Set(["blocks", "stride", "timeoutMs", "paceMs", "retries"]);
  const stringFlags = new Set(["baseUrl", "json"]);
  const keys = new Map([
    ["--base-url", "baseUrl"],
    ["--blocks", "blocks"],
    ["--stride", "stride"],
    ["--timeout-ms", "timeoutMs"],
    ["--pace-ms", "paceMs"],
    ["--retries", "retries"],
    ["--json", "json"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = keys.get(arg);
    if (key === undefined) {
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined) {
      throw new Error(`${arg} requires a value`);
    }
    if (intFlags.has(key)) {
      output[key] = Number.parseInt(next, 10);
    } else if (stringFlags.has(key)) {
      output[key] = next;
    }
    index += 1;
  }
  const chainIndex = argv.indexOf("--chain-ids");
  if (chainIndex !== -1) {
    output.chainIds = argv[chainIndex + 1]
      .split(",")
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((value) => Number.isFinite(value));
  }
  return output;
}

function formatSeconds({ value }) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(2);
}

function printTable({ title, rows }) {
  if (rows.length === 0) {
    return;
  }
  const columns = Object.keys(rows[0]);
  const widths = new Map(
    columns.map((column) => [
      column,
      Math.max(column.length, ...rows.map((row) => String(row[column]).length)),
    ]),
  );
  const border = `+${columns.map((column) => "-".repeat(widths.get(column) + 2)).join("+")}+`;
  const header = `| ${columns
    .map((column) => String(column).padEnd(widths.get(column)))
    .join(" | ")} |`;
  console.log(`\n${title}`);
  console.log(border);
  console.log(header);
  console.log(border);
  for (const row of rows) {
    console.log(
      `| ${columns.map((column) => String(row[column]).padEnd(widths.get(column))).join(" | ")} |`,
    );
  }
  console.log(border);
}
