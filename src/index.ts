import { z } from "zod";

type Env = {
  CHAINLIST_RPCS_URL?: string;
  ALCHEMY_NETWORK_CONFIG_URL?: string;
  DEFAULT_RACE_FANOUT?: string;
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
  shortName?: string;
  rpc: Array<RpcEntry | string>;
};

type NormalizedChain = {
  chainId: number;
  name: string;
  shortName?: string;
  rpcUrls: string[];
};

const DAY_IN_SECONDS = 86_400;
const DEFAULT_RPCS_URL = "https://chainlist.org/rpcs.json";
const DEFAULT_ALCHEMY_NETWORK_CONFIG_URL =
  "https://app-api.alchemy.com/trpc/config.getNetworkConfig";
const INTERNAL_CHAINLIST_CACHE_KEY = "https://rpc-racer.internal/chainlist-rpcs";
const INTERNAL_ALCHEMY_CACHE_KEY = "https://rpc-racer.internal/alchemy-network-config";

const routeSchema = z.object({
  chainId: z.coerce.number().int().positive(),
});

const querySchema = z.object({
  max: z.coerce.number().int().min(1).max(25).optional(),
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
          supportedProducts: z.array(z.string()).optional(),
        })
        .passthrough(),
    ),
  }),
});

let chainMemoryCache: { expiresAt: number; byChainId: Map<number, NormalizedChain> } | null = null;
let alchemyMemoryCache: { expiresAt: number; slugByChainId: Map<number, string> } | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({
        ok: true,
        routes: {
          race: "POST /v1/:chainId",
          chain: "GET /v1/chains/:chainId",
        },
      });
    }

    const raceMatch = url.pathname.match(/^\/v1\/(\d+)$/);
    if (raceMatch !== null) {
      return handleRaceRpc({ env, request, chainIdRaw: raceMatch[1], query: url.searchParams });
    }

    const chainMatch = url.pathname.match(/^\/v1\/chains\/(\d+)$/);
    if (chainMatch !== null) {
      return handleGetChain({ env, chainIdRaw: chainMatch[1] });
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

  const chainMap = await getChainMap({ env });
  const chain = chainMap.get(parsedRoute.data.chainId);

  if (chain === undefined) {
    return jsonResponse({ error: "Unknown chainId" }, { status: 404 });
  }

  return jsonResponse(chain);
}

async function handleRaceRpc({
  env,
  request,
  chainIdRaw,
  query,
}: {
  env: Env;
  request: Request;
  chainIdRaw: string;
  query: URLSearchParams;
}): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Use POST with a JSON-RPC body" }, { status: 405 });
  }

  const parsedRoute = routeSchema.safeParse({ chainId: chainIdRaw });
  if (!parsedRoute.success) {
    return jsonResponse({ error: "Invalid chainId" }, { status: 400 });
  }

  const parsedQuery = querySchema.safeParse({
    max: query.get("max") ?? undefined,
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

  const chainMap = await getChainMap({ env });
  const chain = chainMap.get(parsedRoute.data.chainId);
  if (chain === undefined) {
    return jsonResponse({ error: "Unknown chainId" }, { status: 404 });
  }

  const defaultFanout = parsePositiveInt({ value: env.DEFAULT_RACE_FANOUT, fallback: 8 });
  const defaultTimeoutMs = parsePositiveInt({ value: env.DEFAULT_TIMEOUT_MS, fallback: 2_500 });

  const max = parsedQuery.data.max ?? defaultFanout;
  const timeoutMs = parsedQuery.data.timeoutMs ?? defaultTimeoutMs;

  const candidateUrls = chain.rpcUrls.slice(0, max);
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

      if (isJsonRpcRateLimitError({ value: parsed })) {
        throw new Error("JSON-RPC rate limited");
      }

      return { url, body, status: response.status };
    } finally {
      clearTimeout(timeout);
    }
  });

  try {
    const winner = await Promise.any(attempts);
    for (const controller of controllers) {
      controller.abort("Winner selected");
    }
    return winner;
  } catch {
    return null;
  }
}

async function getChainMap({ env }: { env: Env }): Promise<Map<number, NormalizedChain>> {
  const now = Date.now();
  if (chainMemoryCache !== null && now < chainMemoryCache.expiresAt) {
    return chainMemoryCache.byChainId;
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
  for (const chain of validated.data as ChainEntry[]) {
    const rpcUrls = normalizeRpcUrls({ rpcList: chain.rpc });
    byChainId.set(chain.chainId, {
      chainId: chain.chainId,
      name: chain.name,
      shortName: chain.shortName,
      rpcUrls,
    });
  }

  chainMemoryCache = {
    expiresAt: now + DAY_IN_SECONDS * 1000,
    byChainId,
  };

  return byChainId;
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

function isJsonRpcRateLimitError({ value }: { value: unknown }): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { error?: unknown };
  if (typeof candidate.error !== "object" || candidate.error === null) {
    return false;
  }

  const error = candidate.error as { code?: unknown };
  return error.code === 429;
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
