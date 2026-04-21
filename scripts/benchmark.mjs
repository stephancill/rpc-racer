#!/usr/bin/env bun

const DEFAULT_BASE_URL = "https://rpc.steer.fun";
const DEFAULT_ROUNDS = 20;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_ADDRESS = "0x8d25687829D6b85d9e0020B8c89e3Ca24dE20a89";

const DEFAULT_CHAINS = [
  { chainId: 1, name: "Ethereum" },
  { chainId: 10, name: "Optimism" },
  { chainId: 8453, name: "Base" },
  { chainId: 42161, name: "Arbitrum" },
  { chainId: 4217, name: "Tempo" },
  { chainId: 137, name: "Polygon" },
  { chainId: 56, name: "BNB" },
];

const args = parseArgs({ argv: process.argv.slice(2) });
const rounds = args.rounds ?? DEFAULT_ROUNDS;
const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
const baseUrl = (args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
const address = args.address ?? DEFAULT_ADDRESS;

const selectedChains =
  args.chains === undefined
    ? DEFAULT_CHAINS
    : DEFAULT_CHAINS.filter((chain) => args.chains.includes(chain.chainId));

if (selectedChains.length === 0) {
  throw new Error("No valid chains selected. Use --chains 1,10,8453 etc.");
}

const payload = {
  jsonrpc: "2.0",
  method: "eth_getBalance",
  params: [address, "latest"],
  id: 1,
};

console.log(`Benchmarking ${baseUrl} (rounds=${rounds}, timeoutMs=${timeoutMs})`);
console.log(`Address: ${address}`);

const proxyResults = [];
for (const chain of selectedChains) {
  proxyResults.push(
    await benchmarkEndpoint({
      label: `${chain.name} (${chain.chainId})`,
      rounds,
      url: `${baseUrl}/v1/${chain.chainId}?timeoutMs=${timeoutMs}`,
      payload,
      trackProxyHeaders: true,
    }),
  );
}

printTable({
  title: "Proxy Benchmark",
  rows: proxyResults.map((result, index) => {
    const chain = selectedChains[index];
    return {
      Chain: chain.name,
      ChainId: chain.chainId,
      OK: result.ok,
      Errors: result.errors,
      AvgMs: formatMs({ value: result.avgMs }),
      P95Ms: formatMs({ value: result.p95Ms }),
      FallbackPct: `${toPercent({ value: result.fallbackRatio })}%`,
      TopProvider: result.topProvider,
    };
  }),
});

const alchemyKey = Bun.env.ALCHEMY_API_KEY;
if (alchemyKey !== undefined && alchemyKey.length > 0) {
  const slugByChainId = await fetchAlchemySlugMap();
  const compareRows = [];

  for (const chain of selectedChains) {
    const slug = slugByChainId.get(chain.chainId);
    if (slug === undefined) {
      continue;
    }

    const alchemyResult = await benchmarkEndpoint({
      label: `Alchemy ${chain.chainId}`,
      rounds,
      url: `https://${slug}.g.alchemy.com/v2/${alchemyKey}`,
      payload,
      trackProxyHeaders: false,
    });

    const proxyResult =
      proxyResults[selectedChains.findIndex((item) => item.chainId === chain.chainId)];
    compareRows.push({
      Chain: chain.name,
      ProxyAvgMs: formatMs({ value: proxyResult.avgMs }),
      AlchemyAvgMs: formatMs({ value: alchemyResult.avgMs }),
      DeltaMs: formatMs({ value: proxyResult.avgMs - alchemyResult.avgMs }),
      ProxyErr: proxyResult.errors,
      AlchemyErr: alchemyResult.errors,
    });
  }

  if (compareRows.length > 0) {
    printTable({ title: "Proxy vs Alchemy", rows: compareRows });
  }
} else {
  console.log("\nSet ALCHEMY_API_KEY to include direct Alchemy comparison.");
}

async function benchmarkEndpoint({ label, rounds, url, payload, trackProxyHeaders }) {
  const latencies = [];
  let ok = 0;
  let errors = 0;
  let fallbackCount = 0;
  const providerCounts = new Map();

  for (let index = 0; index < rounds; index += 1) {
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const elapsed = performance.now() - started;
      const body = await response.json().catch(() => null);

      if (response.ok && body !== null && typeof body === "object" && body.result !== undefined) {
        ok += 1;
        latencies.push(elapsed);

        if (trackProxyHeaders) {
          if (response.headers.get("x-rpc-fallback") === "alchemy") {
            fallbackCount += 1;
          }

          const provider = response.headers.get("x-rpc-provider");
          if (provider !== null) {
            providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
          }
        }
      } else {
        errors += 1;
      }
    } catch {
      errors += 1;
    }
  }

  const sortedLatencies = [...latencies].sort((left, right) => left - right);
  const topProvider =
    [...providerCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "-";

  return {
    label,
    ok,
    errors,
    avgMs: sortedLatencies.length === 0 ? Number.NaN : average({ values: sortedLatencies }),
    p95Ms:
      sortedLatencies.length === 0
        ? Number.NaN
        : percentile({ values: sortedLatencies, percentile: 0.95 }),
    fallbackRatio: rounds === 0 ? 0 : fallbackCount / rounds,
    topProvider,
  };
}

async function fetchAlchemySlugMap() {
  const response = await fetch("https://app-api.alchemy.com/trpc/config.getNetworkConfig", {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Alchemy config: ${response.status}`);
  }

  const payload = await response.json();
  const networks = payload?.result?.data;
  if (!Array.isArray(networks)) {
    throw new Error("Alchemy config payload missing result.data");
  }

  const map = new Map();
  for (const network of networks) {
    if (typeof network?.networkChainId !== "number") {
      continue;
    }
    if (typeof network?.kebabCaseId !== "string") {
      continue;
    }
    const supportsNodeApi = Array.isArray(network?.supportedProducts)
      ? network.supportedProducts.includes("node-api")
      : true;
    if (!supportsNodeApi || map.has(network.networkChainId)) {
      continue;
    }
    map.set(network.networkChainId, network.kebabCaseId);
  }

  return map;
}

function parseArgs({ argv }) {
  const output = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--rounds" && next !== undefined) {
      output.rounds = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (arg === "--timeout-ms" && next !== undefined) {
      output.timeoutMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (arg === "--base-url" && next !== undefined) {
      output.baseUrl = next;
      index += 1;
      continue;
    }

    if (arg === "--address" && next !== undefined) {
      output.address = next;
      index += 1;
      continue;
    }

    if (arg === "--chains" && next !== undefined) {
      output.chains = next
        .split(",")
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isFinite(value));
      index += 1;
      continue;
    }
  }

  return output;
}

function average({ values }) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function percentile({ values, percentile }) {
  const position = Math.min(values.length - 1, Math.floor(values.length * percentile));
  return values[position];
}

function formatMs({ value }) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(2);
}

function toPercent({ value }) {
  return (value * 100).toFixed(1);
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
