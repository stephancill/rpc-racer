#!/usr/bin/env bun

// Drives the /v1/chains block-speed refresh until every chain has a computed
// blockSpeedMs. Each GET /v1/chains triggers an incremental background fill
// (only chains without a stored value), so repeatedly polling with a short
// pause populates the full set over time. The response's `covered` counter
// tells us when we're done.
//
// Usage:
//   bun scripts/fill-block-speeds.mjs [--base-url ...] [--concurrency 8]
//     [--poll-ms 4000] [--max-wait-ms 1800000]

const DEFAULT_BASE_URL = "https://evm.stupidtech.net";
const DEFAULT_POLL_MS = 4000;
const DEFAULT_MAX_WAIT_MS = 30 * 60_000; // 30 min safety bound

const args = parseArgs({ argv: process.argv.slice(2) });
const baseUrl = (args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const pollMs = args.pollMs ?? DEFAULT_POLL_MS;
const maxWaitMs = args.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

console.log(`Filling block speeds from ${baseUrl} (poll=${pollMs}ms, maxWait=${maxWaitMs}ms)`);

const startedAt = Date.now();
let lastCovered = -1;
let lastReportAt = 0;
let totalSeen = 0;

while (Date.now() - startedAt < maxWaitMs) {
  const payload = await fetchRegistry({ baseUrl });
  const total = payload.total ?? payload.chains?.length ?? 0;
  const covered = payload.covered ?? 0;
  totalSeen = total;

  if (Date.now() - lastReportAt > 10_000 || covered !== lastCovered) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`covered ${covered}/${total} (${elapsed}s)`);
    lastCovered = covered;
    lastReportAt = Date.now();
  }

  if (covered >= total) {
    console.log(`\nDone: ${covered}/${total} chains have blockSpeedsMs.`);
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
    if (key === "pollMs" || key === "maxWaitMs") {
      output[key] = Number.parseInt(next, 10);
    } else {
      output[key] = next;
    }
    index += 1;
  }
  return output;
}
