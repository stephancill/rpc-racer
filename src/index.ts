import { z } from "zod";

type Env = {
  CHAINLIST_RPCS_URL?: string;
  ALCHEMY_NETWORK_CONFIG_URL?: string;
  DEFAULT_TIMEOUT_MS?: string;
  ALCHEMY_API_KEY?: string;
};

type RpcEntry = {
  url: string;
  tracking?: string;
};

type ChainEntry = {
  chainId: number;
  name: string;
  chain?: string;
  shortName?: string;
  chainSlug?: string;
  isTestnet?: boolean;
  rpc: Array<RpcEntry | string>;
};

type NormalizedChain = {
  chainId: number;
  name: string;
  shortName?: string;
  chainSlug?: string;
  isTestnet: boolean;
  aliases: string[];
  rpcUrls: string[];
};

type ChainRegistry = {
  byChainId: Map<number, NormalizedChain>;
  orderedChains: NormalizedChain[];
};

const DAY_IN_SECONDS = 86_400;
const RANDOM_RACE_FANOUT = 10;
const DEFAULT_RPCS_URL = "https://chainlist.org/rpcs.json";
const DEFAULT_ALCHEMY_NETWORK_CONFIG_URL =
  "https://app-api.alchemy.com/trpc/config.getNetworkConfig";
const INTERNAL_CHAINLIST_CACHE_KEY = "https://rpc-racer.internal/chainlist-rpcs";
const INTERNAL_ALCHEMY_CACHE_KEY = "https://rpc-racer.internal/alchemy-network-config";

const routeSchema = z.object({
  chainId: z.coerce.number().int().positive(),
});

const querySchema = z.object({
  timeoutMs: z.coerce.number().int().min(200).max(10_000).optional(),
});

const jsonRpcSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: z.unknown().optional(),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
  })
  .passthrough();

const chainsArraySchema = z.array(
  z
    .object({
      chainId: z.number(),
      name: z.string(),
      shortName: z.string().optional(),
      rpc: z.array(z.union([z.string(), z.object({ url: z.string() }).passthrough()])),
    })
    .passthrough(),
);

const alchemyNetworkConfigSchema = z.object({
  result: z.object({
    data: z.array(
      z
        .object({
          networkChainId: z.number().int().positive().nullable().optional(),
          kebabCaseId: z.string().min(1),
          supportedProducts: z.array(z.string().nullable()).optional(),
        })
        .passthrough(),
    ),
  }),
});

let chainMemoryCache: { expiresAt: number; registry: ChainRegistry } | null = null;
let alchemyMemoryCache: { expiresAt: number; slugByChainId: Map<number, string> } | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      const acceptHeader = request.headers.get("accept") ?? "";
      if (acceptHeader.includes("application/json")) {
        return jsonResponse({
          ok: true,
          routes: {
            race: "POST /v1/:chain",
            chains: "GET /v1/chains",
            chain: "GET /v1/chains/:chainId",
          },
        });
      }

      return htmlResponse({
        html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>evm.stupidtech.net</title>
  </head>
  <body>
    <h1>evm.stupidtech.net</h1>
    <p>Proxy that races EVM RPC requests between providers.</p>
    <h2>Endpoints</h2>
    <ul>
      <li><code>POST /v1/:chain</code></li>
      <li><code>GET /v1/chains</code></li>
      <li><code>GET /v1/chains/:chainId</code></li>
    </ul>
    <p>
      <a href="https://github.com/stephancill/rpc-racer">github</a>
      •
      <a href="https://x.com/stephancill">twitter</a>
      •
      <a href="https://stupidtech.net">stupidtech.net</a>
    </p>
  </body>
</html>`,
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/chains") {
      return handleListChains({ env, query: url.searchParams });
    }

    const chainMatch = url.pathname.match(/^\/v1\/chains\/(\d+)$/);
    if (chainMatch !== null) {
      return handleGetChain({ env, chainIdRaw: chainMatch[1] });
    }

    const raceMatch = url.pathname.match(/^\/v1\/([^/]+)$/);
    if (raceMatch !== null) {
      return handleRaceRpc({
        env,
        request,
        chainSelectorRaw: decodeURIComponent(raceMatch[1]),
        query: url.searchParams,
      });
    }

    return jsonResponse({ error: "Not found" }, { status: 404 });
  },
};

async function handleGetChain({
  env,
  chainIdRaw,
}: {
  env: Env;
  chainIdRaw: string;
}): Promise<Response> {
  const parsedRoute = routeSchema.safeParse({ chainId: chainIdRaw });
  if (!parsedRoute.success) {
    return jsonResponse({ error: "Invalid chainId" }, { status: 400 });
  }

  const registry = await getChainRegistry({ env });
  const chain = registry.byChainId.get(parsedRoute.data.chainId);

  if (chain === undefined) {
    return jsonResponse({ error: "Unknown chainId" }, { status: 404 });
  }

  return jsonResponse(chain);
}

async function handleListChains({
  env,
  query,
}: {
  env: Env;
  query: URLSearchParams;
}): Promise<Response> {
  const includeRpcUrls = query.has("includeRpcUrls");
  const registry = await getChainRegistry({ env });

  const chains = registry.orderedChains.map((chain) => {
    if (includeRpcUrls) {
      return chain;
    }

    return {
      chainId: chain.chainId,
      name: chain.name,
      shortName: chain.shortName,
      chainSlug: chain.chainSlug,
      isTestnet: chain.isTestnet,
      aliases: chain.aliases,
      rpcUrlCount: chain.rpcUrls.length,
    };
  });

  return jsonResponse({
    total: chains.length,
    includeRpcUrls,
    chains,
  });
}

async function handleRaceRpc({
  env,
  request,
  chainSelectorRaw,
  query,
}: {
  env: Env;
  request: Request;
  chainSelectorRaw: string;
  query: URLSearchParams;
}): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Use POST with a JSON-RPC body" }, { status: 405 });
  }

  const parsedQuery = querySchema.safeParse({
    timeoutMs: query.get("timeoutMs") ?? undefined,
  });
  if (!parsedQuery.success) {
    return jsonResponse({ error: "Invalid query params" }, { status: 400 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const validatedBody = jsonRpcSchema.safeParse(parsedBody);
  if (!validatedBody.success) {
    return jsonResponse({ error: "Body must be a JSON-RPC 2.0 request" }, { status: 400 });
  }

  const registry = await getChainRegistry({ env });
  const preferTestnet = query.has("testnet");
  const chain = resolveChainSelector({
    selector: chainSelectorRaw,
    preferTestnet,
    registry,
  });
  if (chain === undefined) {
    return jsonResponse({ error: "Unknown chain" }, { status: 404 });
  }

  const defaultTimeoutMs = parsePositiveInt({ value: env.DEFAULT_TIMEOUT_MS, fallback: 2_500 });

  const timeoutMs = parsedQuery.data.timeoutMs ?? defaultTimeoutMs;

  const candidateUrls = selectRandomRpcUrls({ rpcUrls: chain.rpcUrls, count: RANDOM_RACE_FANOUT });
  if (candidateUrls.length === 0) {
    return jsonResponse({ error: "No usable HTTP RPC URLs for chain" }, { status: 502 });
  }

  const requestBody = JSON.stringify(validatedBody.data);
  const winner = await raceRequests({ candidateUrls, requestBody, timeoutMs });
  if (winner === null) {
    const alchemy = await tryAlchemyFallback({
      chainId: chain.chainId,
      requestBody,
      env,
      timeoutMs,
    });

    if (alchemy !== null) {
      const provider = providerFromUrl({ url: alchemy.url });
      return new Response(alchemy.body, {
        status: alchemy.status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-rpc-upstream": alchemy.url,
          "x-rpc-provider": provider,
          "x-rpc-chain-id": String(chain.chainId),
          "x-rpc-chain-name": chain.name,
          "x-rpc-fallback": "alchemy",
        },
      });
    }

    return jsonResponse(
      {
        error: "All RPC endpoints failed",
        chainId: chain.chainId,
        tried: candidateUrls.length,
        alchemyAttempted: Boolean(env.ALCHEMY_API_KEY && env.ALCHEMY_API_KEY.trim().length > 0),
      },
      { status: 502 },
    );
  }

  const provider = providerFromUrl({ url: winner.url });
  return new Response(winner.body, {
    status: winner.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-rpc-upstream": winner.url,
      "x-rpc-provider": provider,
      "x-rpc-chain-id": String(chain.chainId),
      "x-rpc-chain-name": chain.name,
    },
  });
}

async function tryAlchemyFallback({
  chainId,
  requestBody,
  env,
  timeoutMs,
}: {
  chainId: number;
  requestBody: string;
  env: Env;
  timeoutMs: number;
}): Promise<{ url: string; body: string; status: number } | null> {
  const alchemyApiKey = env.ALCHEMY_API_KEY?.trim();
  if (alchemyApiKey === undefined || alchemyApiKey.length === 0) {
    return null;
  }

  let slugByChainId: Map<number, string>;
  try {
    slugByChainId = await getAlchemyNetworkSlugMap({ env });
  } catch {
    return null;
  }

  const slug = slugByChainId.get(chainId);
  if (slug === undefined) {
    return null;
  }

  const alchemyUrl = `https://${slug}.g.alchemy.com/v2/${alchemyApiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Alchemy timeout"), timeoutMs);

  try {
    const response = await fetch(alchemyUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: requestBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const body = await response.text();
    const parsed = safeJsonParse({ value: body });
    if (!isJsonRpcResponse({ value: parsed })) {
      return null;
    }

    return {
      url: alchemyUrl,
      body,
      status: response.status,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function raceRequests({
  candidateUrls,
  requestBody,
  timeoutMs,
}: {
  candidateUrls: string[];
  requestBody: string;
  timeoutMs: number;
}): Promise<{ url: string; body: string; status: number } | null> {
  const controllers: AbortController[] = [];

  const attempts = candidateUrls.map(async (url) => {
    const controller = new AbortController();
    controllers.push(controller);
    const timeout = setTimeout(() => controller.abort("RPC timeout"), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: requestBody,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = await response.text();
      const parsed = safeJsonParse({ value: body });
      if (!isJsonRpcResponse({ value: parsed })) {
        throw new Error("Not a JSON-RPC response");
      }

      return {
        url,
        body,
        status: response.status,
        hasJsonRpcError: isJsonRpcError({ value: parsed }),
      };
    } finally {
      clearTimeout(timeout);
    }
  });

  const wrapped = attempts.map(async (attempt, index) => {
    try {
      const value = await attempt;
      return { index, ok: true as const, value };
    } catch (error) {
      return { index, ok: false as const, error };
    }
  });

  try {
    const pending = new Set<number>(wrapped.map((_, index) => index));
    let jsonRpcResponsesObserved = 0;
    let jsonRpcErrorsObserved = 0;

    while (pending.size > 0) {
      const next = await Promise.race([...pending].map((index) => wrapped[index]));
      pending.delete(next.index);

      if (!next.ok) {
        continue;
      }

      if (!next.value.hasJsonRpcError) {
        abortAll({ controllers });
        return { url: next.value.url, body: next.value.body, status: next.value.status };
      }

      jsonRpcResponsesObserved += 1;
      jsonRpcErrorsObserved += 1;

      if (jsonRpcResponsesObserved >= 5 && jsonRpcErrorsObserved >= 5) {
        abortAll({ controllers });
        return null;
      }
    }

    abortAll({ controllers });
    return null;
  } catch {
    abortAll({ controllers });
    return null;
  }
}

async function getChainRegistry({ env }: { env: Env }): Promise<ChainRegistry> {
  const now = Date.now();
  if (chainMemoryCache !== null && now < chainMemoryCache.expiresAt) {
    return chainMemoryCache.registry;
  }

  const cache = caches.default;
  const cacheKey = new Request(INTERNAL_CHAINLIST_CACHE_KEY);
  const cached = await cache.match(cacheKey);

  let rawJson: string;
  if (cached !== undefined) {
    rawJson = await cached.text();
  } else {
    const sourceUrl = env.CHAINLIST_RPCS_URL ?? DEFAULT_RPCS_URL;
    const response = await fetch(sourceUrl, {
      headers: {
        accept: "application/json",
      },
      cf: {
        cacheEverything: true,
        cacheTtl: DAY_IN_SECONDS,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch chain data: ${response.status}`);
    }

    rawJson = await response.text();

    await cache.put(
      cacheKey,
      new Response(rawJson, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${DAY_IN_SECONDS}`,
        },
      }),
    );
  }

  const parsed = safeJsonParse({ value: rawJson });
  const validated = chainsArraySchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error("Invalid chain list payload");
  }

  const byChainId = new Map<number, NormalizedChain>();
  const orderedChains: NormalizedChain[] = [];
  for (const chain of validated.data as ChainEntry[]) {
    const rpcUrls = normalizeRpcUrls({ rpcList: chain.rpc });
    const normalized = {
      chainId: chain.chainId,
      name: chain.name,
      chainSlug: chain.chainSlug,
      shortName: chain.shortName,
      isTestnet: Boolean(chain.isTestnet),
      aliases: buildChainAliases({ chain }),
      rpcUrls,
    };

    byChainId.set(chain.chainId, normalized);
    orderedChains.push(normalized);
  }

  const registry = { byChainId, orderedChains };
  chainMemoryCache = {
    expiresAt: now + DAY_IN_SECONDS * 1000,
    registry,
  };

  return registry;
}

function resolveChainSelector({
  selector,
  preferTestnet,
  registry,
}: {
  selector: string;
  preferTestnet: boolean;
  registry: ChainRegistry;
}): NormalizedChain | undefined {
  const trimmedSelector = selector.trim();
  const numeric = Number.parseInt(trimmedSelector, 10);
  if (Number.isFinite(numeric) && String(numeric) === trimmedSelector) {
    return registry.byChainId.get(numeric);
  }

  const normalizedSelector = trimmedSelector.toLowerCase();
  const matching = registry.orderedChains.filter((chain) =>
    chain.aliases.some(
      (alias) =>
        alias === normalizedSelector ||
        alias.startsWith(`${normalizedSelector}-`) ||
        alias.startsWith(`${normalizedSelector} `),
    ),
  );

  if (matching.length === 0) {
    return undefined;
  }

  if (preferTestnet) {
    return matching.find((chain) => chain.isTestnet) ?? undefined;
  }

  return matching.find((chain) => !chain.isTestnet) ?? undefined;
}

function buildChainAliases({ chain }: { chain: ChainEntry }): string[] {
  const aliases = new Set<string>();
  aliases.add(String(chain.chainId));

  const values = [chain.name, chain.shortName, chain.chainSlug, chain.chain];
  for (const value of values) {
    if (value === undefined || value.trim().length === 0) {
      continue;
    }
    aliases.add(value.trim().toLowerCase());
  }

  return [...aliases];
}

async function getAlchemyNetworkSlugMap({ env }: { env: Env }): Promise<Map<number, string>> {
  const now = Date.now();
  if (alchemyMemoryCache !== null && now < alchemyMemoryCache.expiresAt) {
    return alchemyMemoryCache.slugByChainId;
  }

  const cache = caches.default;
  const cacheKey = new Request(INTERNAL_ALCHEMY_CACHE_KEY);
  const cached = await cache.match(cacheKey);

  let rawJson: string;
  if (cached !== undefined) {
    rawJson = await cached.text();
  } else {
    const sourceUrl = env.ALCHEMY_NETWORK_CONFIG_URL ?? DEFAULT_ALCHEMY_NETWORK_CONFIG_URL;
    const response = await fetch(sourceUrl, {
      headers: {
        accept: "application/json",
      },
      cf: {
        cacheEverything: true,
        cacheTtl: DAY_IN_SECONDS,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Alchemy network config: ${response.status}`);
    }

    rawJson = await response.text();

    await cache.put(
      cacheKey,
      new Response(rawJson, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${DAY_IN_SECONDS}`,
        },
      }),
    );
  }

  const parsed = safeJsonParse({ value: rawJson });
  const validated = alchemyNetworkConfigSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error("Invalid Alchemy network config payload");
  }

  const slugByChainId = new Map<number, string>();
  for (const network of validated.data.result.data) {
    if (network.networkChainId === null || network.networkChainId === undefined) {
      continue;
    }

    const supportsNodeApi =
      network.supportedProducts === undefined || network.supportedProducts.includes("node-api");
    if (!supportsNodeApi) {
      continue;
    }

    if (!slugByChainId.has(network.networkChainId)) {
      slugByChainId.set(network.networkChainId, network.kebabCaseId);
    }
  }

  alchemyMemoryCache = {
    expiresAt: now + DAY_IN_SECONDS * 1000,
    slugByChainId,
  };

  return slugByChainId;
}

function normalizeRpcUrls({ rpcList }: { rpcList: Array<RpcEntry | string> }): string[] {
  const urls = new Set<string>();

  for (const entry of rpcList) {
    const rawUrl = typeof entry === "string" ? entry : entry.url;
    const url = rawUrl.trim();

    if (!url.startsWith("https://")) {
      continue;
    }

    if (/\$\{[^}]+\}/.test(url)) {
      continue;
    }

    urls.add(url);
  }

  return [...urls];
}

function selectRandomRpcUrls({ rpcUrls, count }: { rpcUrls: string[]; count: number }): string[] {
  const shuffled = [...rpcUrls];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }

  return shuffled.slice(0, count);
}

function parsePositiveInt({
  value,
  fallback,
}: {
  value: string | undefined;
  fallback: number;
}): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function safeJsonParse({ value }: { value: string }): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isJsonRpcResponse({ value }: { value: unknown }): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { jsonrpc?: unknown };
  return candidate.jsonrpc === "2.0";
}

function isJsonRpcError({ value }: { value: unknown }): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { error?: unknown };
  return typeof candidate.error === "object" && candidate.error !== null;
}

function abortAll({ controllers }: { controllers: AbortController[] }): void {
  for (const controller of controllers) {
    controller.abort("Winner selected");
  }
}

function providerFromUrl({ url }: { url: string }): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers,
    },
  });
}

function htmlResponse({ html, init }: { html: string; init?: ResponseInit }): Response {
  return new Response(html, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...init?.headers,
    },
  });
}
