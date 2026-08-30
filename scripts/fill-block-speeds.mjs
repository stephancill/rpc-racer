#!/usr/bin/env bun

// Drives the /v1/chains block-speed refresh until every chain has a computed
// blockSpeedMs. Each GET /v1/chains triggers an incremental background fill
// (only chains without a stored value), so repeatedly polling with a short
// pause populates the full set over time. The response's `covered` counter
// tells us when we're done.
//
// Usage:
//   bun scripts/fill-block-speeds.mjs [--base-url ...] [--parallel 24]
//     [--poll-ms 3000] [--max-wait-ms 1800000]

const DEFAULT_BASE_URL = "https://evm.stupidtech.net";
const DEFAULT_PARALLEL = 24;
const DEFAULT_POLL_MS = 3000;
const DEFAULT_MAX_WAIT_MS = 30 * 60_000; // 30 min limit bound

const args = parseArgs({ argv: process.argv.slice(2) });
const baseUrl = (args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const parallel = args.parallel ?? DEFAULT_PARALLEL;
const pollMs = args.pollMs ?? DEFAULT_POLL_MS;
const maxWaitMs = args.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

console.log(
  `Filling block speeds from ${baseUrl} (parallel=${parallel}, poll=${pollMs}ms, maxWait=${maxWaitMs}ms)`,
);

const startedAt = Date.now();
let lastCovered = -1;
let lastProgressAt = Date.now();
let totalSeen = 0;
const STALE_MS = 75_000; // report done when no progress for this long

while (Date.now() - startedAt < maxWaitMs) {
  // Each GET /v1/chains triggers a background fill bounded by the worker's
  // per-request subrequest cap, so fan out many requests to spread capped fills
  // across edge isolates and fill far more quickly.
  const payloads = await Promise.all(
    Array.from({ length: parallel }, () => fetchRegistry({ baseUrl })),
  );
  const payload = payloads[0] ?? {};
  const total = payload.total ?? payload.chains?.length ?? 0;
  const covered = payload.covered ?? 0;
  totalSeen = total;

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`covered ${covered}/${total} (${elapsed}s)`);

  if (covered >= total) {
    console.log(`\nDone: ${covered}/${total} chains have a blockSpeedMs.`);
    process.exit(0);
  }

  if (covered !== lastCovered) {
    lastProgressAt = Date.now();
    lastCovered = covered;
  } else if (Date.now() - lastProgressAt >= STALE_MS) {
    console.log(
      `\nNo progress for ${STALE_MS / 1000}s at ${covered}/${total}. ` +
        "Remaining chains have no publicly usable RPC, so no value is stored.",
    );
    process.exit(0);
  }

  await sleep(pollMs);
}

console.error(
  `Timed out after ${maxWaitMs}ms. Covered ${`${lastCovered}`} of ${totalSeen}. ` +
    "Run again to keep filling.",
);
process.exit(1);

async function fetchRegistry({ baseUrl }) {
  const response = await fetch(`${baseUrl}/v1/chains`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch chains: ${response.status}`);
  }
  return await response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs({ argv }) {
  const output = {};
  const keys = new Map([
    ["--base-url", "baseUrl"],
    ["--parallel", "parallel"],
    ["--poll-ms", "pollMs"],
    ["--max-wait-ms", "maxWaitMs"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = keys.get(argv[index]);
    if (key === undefined) {
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined) {
      throw new Error(`${argv[index]} requires a value`);
    }
    if (key === "parallel" || key === "pollMs" || key === "maxWaitMs") {
      output[key] = Number.parseInt(next, 10);
    } else {
      output[key] = next;
    }
    index += 1;
  }
  return output;
}
