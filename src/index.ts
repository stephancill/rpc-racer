import { z } from "zod";

type Env = {
  CHAINLIST_RPCS_URL?: string;
  ALCHEMY_NETWORK_CONFIG_URL?: string;
  DEFAULT_TIMEOUT_MS?: string;
  ALCHEMY_API_KEY?: string;
  METRICS_DO: DurableObjectNamespace;
  ASSETS: Fetcher;
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
  wsRpcUrls: string[];
};

type ChainRegistry = {
  byChainId: Map<number, NormalizedChain>;
  orderedChains: NormalizedChain[];
};

export type ChainMethodLatencySamples = Record<string, Record<string, number[]>>;

type ChainMethodLatencyMethodStats = {
  method: string;
  sampleCount: number;
  averageLatencyMs: number;
  medianLatencyMs: number;
};

export type ChainMethodLatencyStats = {
  chainId: number;
  methods: ChainMethodLatencyMethodStats[];
};

type MetricsStorageSnapshot = {
  requestsServed: number;
  fallbackResponses: number;
  latencySumMs: number;
  latencyCount: number;
  latencyMaxMs: number;
  latencyBuckets: Record<string, number>;
  chainMethodLatencySamples: ChainMethodLatencySamples;
};

type RpcMetricsSnapshot = Omit<MetricsStorageSnapshot, "chainMethodLatencySamples"> & {
  chainMethodLatencies: ChainMethodLatencyStats[];
};

type RpcMetricsRecord = {
  requestCount: number;
  fallbackCount: number;
  latencyMs: number;
  latencySampleCount: number;
  chainId?: number;
  method?: string;
};

type JsonRpcErrorDetail = {
  code?: number;
  message: string;
  data?: unknown;
};

const DAY_IN_SECONDS = 86_400;
const RANDOM_RACE_FANOUT = 5;
const MAX_CHAIN_METHOD_LATENCY_SAMPLES = 1000;
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, accept",
          "access-control-max-age": "86400",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/") {
      const acceptHeader = request.headers.get("accept") ?? "";
      if (acceptHeader.includes("application/json")) {
        const metrics = await getRpcMetricsSnapshot({ env });
        return jsonResponse({
          ok: true,
          routes: {
            race: "POST /v1/:chainId",
            subscriptions: "WebSocket /v1/:chainId",
            chains: "GET /v1/chains",
            chain: "GET /v1/chains/:chainId",
            stats: "GET /stats",
          },
          metrics,
        });
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/chains") {
      return handleListChains({ env, query: url.searchParams });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      const metrics = await getRpcMetricsSnapshot({ env });
      return jsonResponse({ ok: true, metrics });
    }

    const chainMatch = url.pathname.match(/^\/v1\/chains\/(\d+)$/);
    if (chainMatch !== null) {
      return handleGetChain({ env, chainIdRaw: chainMatch[1] });
    }

    const raceMatch = url.pathname.match(/^\/v1\/([^/]+)$/);
    if (raceMatch !== null) {
      if (isWebSocketUpgrade({ request })) {
        return handleWebSocketRpc({
          env,
          request,
          chainSelectorRaw: decodeURIComponent(raceMatch[1]),
          query: url.searchParams,
        });
      }

      return handleRaceRpc({
        env,
        ctx,
        request,
        chainSelectorRaw: decodeURIComponent(raceMatch[1]),
        query: url.searchParams,
      });
    }

    if (request.method === "GET" || request.method === "HEAD") {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) {
        return assetResponse;
      }
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
      wsRpcUrlCount: chain.wsRpcUrls.length,
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
  ctx,
  request,
  chainSelectorRaw,
  query,
}: {
  env: Env;
  ctx: ExecutionContext;
  request: Request;
  chainSelectorRaw: string;
  query: URLSearchParams;
}): Promise<Response> {
  const startedAt = performance.now();
  if (request.method !== "POST") {
    return finalizeRpcResponse({
      env,
      ctx,
      startedAt,
      response: jsonResponse({ error: "Use POST with a JSON-RPC body" }, { status: 405 }),
      fallbackUsed: false,
    });
  }

  const parsedQuery = querySchema.safeParse({
    timeoutMs: query.get("timeoutMs") ?? undefined,
  });
  if (!parsedQuery.success) {
    return finalizeRpcResponse({
      env,
      ctx,
      startedAt,
      response: jsonResponse({ error: "Invalid query params" }, { status: 400 }),
      fallbackUsed: false,
    });
  }

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return finalizeRpcResponse({
      env,
      ctx,
      startedAt,
      response: jsonResponse({ error: "Request body must be valid JSON" }, { status: 400 }),
      fallbackUsed: false,
    });
  }

  const validatedBody = jsonRpcSchema.safeParse(parsedBody);
  if (!validatedBody.success) {
    return finalizeRpcResponse({
      env,
      ctx,
      startedAt,
      response: jsonResponse({ error: "Body must be a JSON-RPC 2.0 request" }, { status: 400 }),
      fallbackUsed: false,
    });
  }

  const registry = await getChainRegistry({ env });
  const preferTestnet = query.has("testnet");
  const chain = resolveChainSelector({
    selector: chainSelectorRaw,
    preferTestnet,
    registry,
  });
  if (chain === undefined) {
    return finalizeRpcResponse({
      env,
      ctx,
      startedAt,
      response: jsonResponse({ error: "Unknown chain" }, { status: 404 }),
      fallbackUsed: false,
    });
  }

  const defaultTimeoutMs = parsePositiveInt({ value: env.DEFAULT_TIMEOUT_MS, fallback: 2_500 });
  const rpcMethod = validatedBody.data.method;
  if (rpcMethod === "eth_subscribe") {
    return finalizeRpcResponse({
      env,
      ctx,
      startedAt,
      response: jsonResponse({
        jsonrpc: "2.0",
        id: validatedBody.data.id ?? null,
        error: {
          code: -32000,
          message: "eth_subscribe requires a WebSocket connection",
        },
      }),
      fallbackUsed: false,
      chainId: chain.chainId,
      method: rpcMethod,
    });
  }

  const timeoutMs = parsedQuery.data.timeoutMs ?? defaultTimeoutMs;

  const candidateUrls = selectRandomRpcUrls({ rpcUrls: chain.rpcUrls, count: RANDOM_RACE_FANOUT });
  if (candidateUrls.length === 0) {
    return finalizeRpcResponse({
      env,
      ctx,
      startedAt,
      response: jsonResponse({ error: "No usable HTTP RPC URLs for chain" }, { status: 502 }),
      fallbackUsed: false,
      chainId: chain.chainId,
      method: rpcMethod,
    });
  }

  const requestBody = JSON.stringify(validatedBody.data);
  const raceResult = await raceRequests({ candidateUrls, requestBody, timeoutMs });
  if (raceResult.winner === null) {
    const hasAlchemyApiKey = Boolean(env.ALCHEMY_API_KEY && env.ALCHEMY_API_KEY.trim().length > 0);
    const shouldTryAlchemyFallback = raceResult.shouldTryAlchemyFallback && hasAlchemyApiKey;
    const alchemy = shouldTryAlchemyFallback
      ? await tryAlchemyFallback({
          chainId: chain.chainId,
          requestBody,
          env,
          timeoutMs,
        })
      : null;

    if (alchemy !== null) {
      const provider = providerFromUrl({ url: alchemy.url });
      const response = new Response(alchemy.body, {
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

      return finalizeRpcResponse({
        env,
        ctx,
        startedAt,
        response,
        fallbackUsed: true,
        chainId: chain.chainId,
        method: rpcMethod,
      });
    }

    return finalizeRpcResponse({
      env,
      ctx,
      startedAt,
      response: jsonResponse(
        {
          error: raceResult.failure?.message ?? "All RPC endpoints failed",
          chainId: chain.chainId,
          tried: candidateUrls.length,
          alchemyAttempted: shouldTryAlchemyFallback,
        },
        {
          status: 502,
          headers: {
            "x-rpc-error-source": "upstream",
          },
        },
      ),
      fallbackUsed: false,
      chainId: chain.chainId,
      method: rpcMethod,
    });
  }

  const provider = providerFromUrl({ url: raceResult.winner.url });
  const response = new Response(raceResult.winner.body, {
    status: raceResult.winner.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-rpc-upstream": raceResult.winner.url,
      "x-rpc-provider": provider,
      "x-rpc-chain-id": String(chain.chainId),
      "x-rpc-chain-name": chain.name,
    },
  });

  return finalizeRpcResponse({
    env,
    ctx,
    startedAt,
    response,
    fallbackUsed: false,
    chainId: chain.chainId,
    method: rpcMethod,
  });
}

async function handleWebSocketRpc({
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
  if (request.method !== "GET") {
    return jsonResponse({ error: "Use GET to open a WebSocket connection" }, { status: 405 });
  }

  const registry = await getChainRegistry({ env });
  const chain = resolveChainSelector({
    selector: chainSelectorRaw,
    preferTestnet: query.has("testnet"),
    registry,
  });
  if (chain === undefined) {
    return jsonResponse({ error: "Unknown chain" }, { status: 404 });
  }

  const candidateUrls = selectRandomRpcUrls({
    rpcUrls: chain.wsRpcUrls,
    count: RANDOM_RACE_FANOUT,
  });
  const alchemyUrl = await getAlchemyRpcUrl({ chainId: chain.chainId, env, protocol: "wss" });
  if (alchemyUrl !== null) {
    candidateUrls.push(alchemyUrl);
  }

  if (candidateUrls.length === 0) {
    return jsonResponse({ error: "No usable WebSocket RPC URLs for chain" }, { status: 502 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  proxyWebSocketConnection({
    clientSocket: server,
    candidateUrls,
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: {
      "x-rpc-chain-id": String(chain.chainId),
      "x-rpc-chain-name": chain.name,
    },
  });
}

async function proxyWebSocketConnection({
  clientSocket,
  candidateUrls,
}: {
  clientSocket: WebSocket;
  candidateUrls: string[];
}): Promise<void> {
  const queuedMessages: Array<string | ArrayBuffer> = [];
  let upstreamSocket: WebSocket | null = null;
  let upstreamReady = false;

  clientSocket.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data !== "string" && !(data instanceof ArrayBuffer)) {
      return;
    }

    if (upstreamReady && upstreamSocket !== null) {
      upstreamSocket.send(data);
      return;
    }

    queuedMessages.push(data);
  });

  clientSocket.addEventListener("close", (event) => {
    upstreamSocket?.close(event.code, event.reason);
  });

  clientSocket.addEventListener("error", () => {
    upstreamSocket?.close(1011, "Client WebSocket error");
  });

  try {
    const connected = await connectFirstWebSocket({ urls: candidateUrls });
    upstreamSocket = connected.socket;
    upstreamReady = true;

    upstreamSocket.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data === "string" || data instanceof ArrayBuffer) {
        clientSocket.send(data);
      }
    });

    upstreamSocket.addEventListener("close", (event) => {
      clientSocket.close(event.code, event.reason);
    });

    upstreamSocket.addEventListener("error", () => {
      clientSocket.close(1011, "Upstream WebSocket error");
    });

    for (const message of queuedMessages.splice(0)) {
      upstreamSocket.send(message);
    }
  } catch {
    clientSocket.close(1011, "No upstream WebSocket available");
  }
}

async function connectFirstWebSocket({ urls }: { urls: string[] }): Promise<{ socket: WebSocket }> {
  const attempts = urls.map((url) => connectWebSocket({ url }));
  const pending = new Set<number>(attempts.map((_, index) => index));

  while (pending.size > 0) {
    const next = await Promise.race(
      [...pending].map(async (index) => {
        try {
          const socket = await attempts[index];
          return { index, socket };
        } catch {
          return { index, socket: null };
        }
      }),
    );
    pending.delete(next.index);

    if (next.socket !== null) {
      for (const index of pending) {
        attempts[index]
          .then((socket) => socket.close(1000, "Another upstream selected"))
          .catch(() => {});
      }
      return { socket: next.socket };
    }
  }

  throw new Error("No upstream WebSocket available");
}

function connectWebSocket({ url }: { url: string }): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close(1000, "Connection timeout");
      reject(new Error("WebSocket connection timeout"));
    }, 5_000);

    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection failed"));
    });
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
  const alchemyUrl = await getAlchemyRpcUrl({ chainId, env, protocol: "https" });
  if (alchemyUrl === null) {
    return null;
  }

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

async function getAlchemyRpcUrl({
  chainId,
  env,
  protocol,
}: {
  chainId: number;
  env: Env;
  protocol: "https" | "wss";
}): Promise<string | null> {
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

  return `${protocol}://${slug}.g.alchemy.com/v2/${alchemyApiKey}`;
}

async function raceRequests({
  candidateUrls,
  requestBody,
  timeoutMs,
}: {
  candidateUrls: string[];
  requestBody: string;
  timeoutMs: number;
}): Promise<{
  winner: { url: string; body: string; status: number } | null;
  shouldTryAlchemyFallback: boolean;
  failure?: {
    message: string;
  };
}> {
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
        likelyStateIssueError: isLikelyStateIssueError({ value: parsed }),
        jsonRpcError: extractJsonRpcError({ value: parsed }),
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
    let stateIssueErrorsObserved = 0;
    let firstJsonRpcError: JsonRpcErrorDetail | null = null;
    let firstTransportError: string | null = null;

    while (pending.size > 0) {
      const next = await Promise.race([...pending].map((index) => wrapped[index]));
      pending.delete(next.index);

      if (!next.ok) {
        if (firstTransportError === null) {
          firstTransportError = formatAttemptError({ error: next.error });
        }
        continue;
      }

      if (!next.value.hasJsonRpcError) {
        abortAll({ controllers });
        return {
          winner: { url: next.value.url, body: next.value.body, status: next.value.status },
          shouldTryAlchemyFallback: false,
        };
      }

      jsonRpcResponsesObserved += 1;
      jsonRpcErrorsObserved += 1;
      if (firstJsonRpcError === null && next.value.jsonRpcError !== null) {
        firstJsonRpcError = next.value.jsonRpcError;
      }
      if (next.value.likelyStateIssueError) {
        stateIssueErrorsObserved += 1;
      }

      if (jsonRpcResponsesObserved >= 5 && jsonRpcErrorsObserved >= 5) {
        abortAll({ controllers });
        return {
          winner: null,
          shouldTryAlchemyFallback: true,
          failure:
            firstJsonRpcError !== null
              ? {
                  message: "All upstream RPCs returned errors",
                }
              : firstTransportError !== null
                ? {
                    message: firstTransportError,
                  }
                : undefined,
        };
      }
    }

    abortAll({ controllers });
    return {
      winner: null,
      shouldTryAlchemyFallback: true,
      failure:
        firstJsonRpcError !== null
          ? {
              message: "All upstream RPCs returned errors",
            }
          : firstTransportError !== null
            ? {
                message: firstTransportError,
              }
            : undefined,
    };
  } catch {
    abortAll({ controllers });
    return {
      winner: null,
      shouldTryAlchemyFallback: false,
      failure: {
        message: "RPC race failed unexpectedly",
      },
    };
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
    const rpcUrls = normalizeRpcUrls({ rpcList: chain.rpc, protocol: "https" });
    const wsRpcUrls = normalizeRpcUrls({ rpcList: chain.rpc, protocol: "wss" });
    const normalized = {
      chainId: chain.chainId,
      name: chain.name,
      chainSlug: chain.chainSlug,
      shortName: chain.shortName,
      isTestnet: Boolean(chain.isTestnet),
      aliases: buildChainAliases({ chain }),
      rpcUrls,
      wsRpcUrls,
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

function normalizeRpcUrls({
  rpcList,
  protocol,
}: {
  rpcList: Array<RpcEntry | string>;
  protocol: "https" | "wss";
}): string[] {
  const urls = new Set<string>();

  for (const entry of rpcList) {
    const rawUrl = typeof entry === "string" ? entry : entry.url;
    const url = rawUrl.trim();

    if (!url.startsWith(`${protocol}://`)) {
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

function isWebSocketUpgrade({ request }: { request: Request }): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
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

function extractJsonRpcError({ value }: { value: unknown }): JsonRpcErrorDetail | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as {
    error?: {
      code?: unknown;
      message?: unknown;
      data?: unknown;
    };
  };

  if (typeof candidate.error?.message !== "string") {
    return null;
  }

  const detail: JsonRpcErrorDetail = {
    message: candidate.error.message,
  };

  if (typeof candidate.error.code === "number") {
    detail.code = candidate.error.code;
  }

  if (candidate.error.data !== undefined) {
    detail.data = candidate.error.data;
  }

  return detail;
}

function formatAttemptError({ error }: { error: unknown }): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "RPC request failed";
}

function isLikelyStateIssueError({ value }: { value: unknown }): boolean {
  if (!isJsonRpcError({ value })) {
    return false;
  }

  const candidate = value as {
    error?: {
      message?: unknown;
      data?: unknown;
    };
  };

  const message =
    typeof candidate.error?.message === "string" ? candidate.error.message.toLowerCase() : "";
  const data = typeof candidate.error?.data === "string" ? candidate.error.data.toLowerCase() : "";
  const combined = `${message} ${data}`;

  return (
    combined.includes("missing trie node") ||
    combined.includes("historical state") ||
    combined.includes("state is not available") ||
    combined.includes("state unavailable") ||
    combined.includes("header not found") ||
    combined.includes("requested data is not available") ||
    combined.includes("requested state is not available") ||
    combined.includes("pruned")
  );
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

async function getRpcMetricsSnapshot({ env }: { env: Env }): Promise<
  RpcMetricsSnapshot & {
    averageLatencyMs: number;
  }
> {
  try {
    const stub = env.METRICS_DO.get(env.METRICS_DO.idFromName("global"));
    const response = await stub.fetch("https://metrics.internal/snapshot");
    if (!response.ok) {
      throw new Error("Failed to read metrics snapshot");
    }

    const snapshot = (await response.json()) as MetricsStorageSnapshot;
    return buildPublicMetricsSnapshot({ snapshot });
  } catch {
    return buildPublicMetricsSnapshot({ snapshot: defaultMetricsSnapshot() });
  }
}

function buildPublicMetricsSnapshot({
  snapshot,
}: {
  snapshot: MetricsStorageSnapshot;
}): RpcMetricsSnapshot & {
  averageLatencyMs: number;
} {
  return {
    requestsServed: snapshot.requestsServed,
    fallbackResponses: snapshot.fallbackResponses,
    latencySumMs: snapshot.latencySumMs,
    latencyCount: snapshot.latencyCount,
    latencyMaxMs: snapshot.latencyMaxMs,
    latencyBuckets: snapshot.latencyBuckets,
    chainMethodLatencies: buildChainMethodLatencyStats({
      samples: snapshot.chainMethodLatencySamples,
    }),
    averageLatencyMs:
      snapshot.latencyCount === 0 ? 0 : snapshot.latencySumMs / snapshot.latencyCount,
  };
}

function finalizeRpcResponse({
  env,
  ctx,
  startedAt,
  response,
  fallbackUsed,
  chainId,
  method,
}: {
  env: Env;
  ctx: ExecutionContext;
  startedAt: number;
  response: Response;
  fallbackUsed: boolean;
  chainId?: number;
  method?: string;
}): Response {
  const latencyMs = Math.max(0, performance.now() - startedAt);
  const shouldTrackLatency = shouldTrackLatencyForSli({ response });
  const record: RpcMetricsRecord = {
    requestCount: 1,
    fallbackCount: fallbackUsed ? 1 : 0,
    latencyMs,
    latencySampleCount: shouldTrackLatency ? 1 : 0,
    chainId,
    method,
  };

  ctx.waitUntil(recordRpcMetrics({ env, record }));

  const corsHeaders = new Headers(response.headers);
  corsHeaders.set("access-control-allow-origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: corsHeaders,
  });
}

async function recordRpcMetrics({
  env,
  record,
}: {
  env: Env;
  record: RpcMetricsRecord;
}): Promise<void> {
  const stub = env.METRICS_DO.get(env.METRICS_DO.idFromName("global"));
  await stub.fetch("https://metrics.internal/record", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(record),
  });
}

function defaultMetricsSnapshot(): MetricsStorageSnapshot {
  return {
    requestsServed: 0,
    fallbackResponses: 0,
    latencySumMs: 0,
    latencyCount: 0,
    latencyMaxMs: 0,
    latencyBuckets: {
      "0-100": 0,
      "100-250": 0,
      "250-500": 0,
      "500-1000": 0,
      "1000-2000": 0,
      "2000+": 0,
    },
    chainMethodLatencySamples: {},
  };
}

function normalizeMetricsSnapshot({
  snapshot,
}: {
  snapshot: Partial<MetricsStorageSnapshot>;
}): MetricsStorageSnapshot {
  const defaults = defaultMetricsSnapshot();
  return {
    requestsServed: Math.max(0, Math.trunc(snapshot.requestsServed ?? 0)),
    fallbackResponses: Math.max(0, Math.trunc(snapshot.fallbackResponses ?? 0)),
    latencySumMs: Math.max(0, snapshot.latencySumMs ?? 0),
    latencyCount: Math.max(0, Math.trunc(snapshot.latencyCount ?? 0)),
    latencyMaxMs: Math.max(0, snapshot.latencyMaxMs ?? 0),
    latencyBuckets: {
      ...defaults.latencyBuckets,
      ...snapshot.latencyBuckets,
    },
    chainMethodLatencySamples: snapshot.chainMethodLatencySamples ?? {},
  };
}

export function appendChainMethodLatencySample({
  samples,
  chainId,
  method,
  latencyMs,
}: {
  samples: ChainMethodLatencySamples;
  chainId: number;
  method: string;
  latencyMs: number;
}): void {
  if (!Number.isFinite(chainId)) {
    return;
  }

  const methodName = method.trim();
  if (methodName.length === 0) {
    return;
  }

  const chainKey = String(Math.trunc(chainId));
  samples[chainKey] ??= {};
  samples[chainKey][methodName] ??= [];

  const methodSamples = samples[chainKey][methodName];
  methodSamples.push(Math.max(0, latencyMs));
  if (methodSamples.length > MAX_CHAIN_METHOD_LATENCY_SAMPLES) {
    methodSamples.splice(0, methodSamples.length - MAX_CHAIN_METHOD_LATENCY_SAMPLES);
  }
}

export function buildChainMethodLatencyStats({
  samples,
}: {
  samples: ChainMethodLatencySamples;
}): ChainMethodLatencyStats[] {
  return Object.entries(samples)
    .map(([chainIdRaw, methods]) => ({
      chainId: Number.parseInt(chainIdRaw, 10),
      methods: Object.entries(methods)
        .filter(([, latencySamples]) => latencySamples.length > 0)
        .map(([method, latencySamples]) => ({
          method,
          sampleCount: latencySamples.length,
          averageLatencyMs:
            latencySamples.reduce((sum, latencyMs) => sum + latencyMs, 0) / latencySamples.length,
          medianLatencyMs: median({ values: latencySamples }),
        }))
        .sort((left, right) => left.method.localeCompare(right.method)),
    }))
    .filter((chainStats) => Number.isFinite(chainStats.chainId) && chainStats.methods.length > 0)
    .sort((left, right) => left.chainId - right.chainId);
}

function median({ values }: { values: number[] }): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }

  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function shouldTrackLatencyForSli({ response }: { response: Response }): boolean {
  if (response.headers.get("x-rpc-error-source") === "upstream") {
    return false;
  }

  return response.status < 500;
}

function latencyBucket({
  latencyMs,
}: {
  latencyMs: number;
}): keyof RpcMetricsSnapshot["latencyBuckets"] {
  if (latencyMs < 100) {
    return "0-100";
  }
  if (latencyMs < 250) {
    return "100-250";
  }
  if (latencyMs < 500) {
    return "250-500";
  }
  if (latencyMs < 1000) {
    return "500-1000";
  }
  if (latencyMs < 2000) {
    return "1000-2000";
  }

  return "2000+";
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...init?.headers,
    },
  });
}

export class MetricsDurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/snapshot") {
      const snapshot = await this.readSnapshot();
      return jsonResponse(snapshot);
    }

    if (request.method === "POST" && url.pathname === "/record") {
      let record: RpcMetricsRecord;
      try {
        record = (await request.json()) as RpcMetricsRecord;
      } catch {
        return jsonResponse({ error: "Invalid metrics payload" }, { status: 400 });
      }

      const snapshot = await this.readSnapshot();
      snapshot.requestsServed += Math.max(0, Math.trunc(record.requestCount));
      snapshot.fallbackResponses += Math.max(0, Math.trunc(record.fallbackCount));
      const latencySampleCount = Math.max(0, Math.trunc(record.latencySampleCount));
      if (latencySampleCount > 0) {
        const latencyMs = Math.max(0, record.latencyMs);
        snapshot.latencyCount += latencySampleCount;
        snapshot.latencySumMs += latencyMs;
        snapshot.latencyMaxMs = Math.max(snapshot.latencyMaxMs, latencyMs);

        if (record.chainId !== undefined && record.method !== undefined) {
          appendChainMethodLatencySample({
            samples: snapshot.chainMethodLatencySamples,
            chainId: record.chainId,
            method: record.method,
            latencyMs,
          });
        }

        const bucket = latencyBucket({ latencyMs });
        snapshot.latencyBuckets[bucket] = (snapshot.latencyBuckets[bucket] ?? 0) + 1;
      }

      await this.state.storage.put("snapshot", snapshot);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Not found" }, { status: 404 });
  }

  private async readSnapshot(): Promise<MetricsStorageSnapshot> {
    const snapshot = await this.state.storage.get<MetricsStorageSnapshot>("snapshot");
    if (snapshot !== undefined) {
      return normalizeMetricsSnapshot({ snapshot });
    }

    const initial = defaultMetricsSnapshot();
    await this.state.storage.put("snapshot", initial);
    return initial;
  }
}
