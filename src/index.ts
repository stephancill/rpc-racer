import { z } from "zod";

type Env = {
  CHAINLIST_RPCS_URL?: string;
  ALCHEMY_NETWORK_CONFIG_URL?: string;
  DEFAULT_TIMEOUT_MS?: string;
  ALCHEMY_API_KEY?: string;
  INTERNAL_SECRET?: string;
  METRICS_DO: DurableObjectNamespace;
  ASSETS: Fetcher;
  RPC_BURST_RATE_LIMITER: RateLimit;
  RPC_SUSTAINED_RATE_LIMITER: RateLimit;
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

type MetricsCounters = Omit<MetricsStorageSnapshot, "chainMethodLatencySamples">;

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
  caller?: "public" | "internal";
  urlResults?: RpcAttemptHealth[];
};

// Per-upstream outcome observed for a single request. `degraded` means the
// endpoint looked unresponsive (transport failure, timeout, or an auth /
// rate-limit provider error) rather than a genuine node-level RPC error.
type RpcAttemptHealth = {
  url: string;
  degraded: boolean;
};

type RpcHealthEntry = {
  consecutiveFailures: number;
  blockedUntil: number;
};

type RpcHealthMap = Record<string, RpcHealthEntry>;

const DAY_IN_SECONDS = 86_400;
// Maximum race fan-out; a client may lower it per-request via the `fanoutCount`
// query param (defaults to this maximum).
const MAX_RANDOM_RACE_FANOUT = 5;
const MAX_CHAIN_METHOD_LATENCY_SAMPLES = 1000;
const COUNTERS_STORAGE_KEY = "counters";
const SAMPLES_KEY_PREFIX = "samples:";
const RPC_HEALTH_STORAGE_KEY = "rpcHealth";
// An upstream must fail (transport, timeout, auth, or rate-limit) this many
// consecutive times before we stop preferring it.
const RPC_HEALTH_FAIL_THRESHOLD = 2;
// How long an endpoint is excluded from the preferred pool once flagged. While
// it keeps failing inside the cooldown the window keeps sliding forward.
const RPC_HEALTH_COOLDOWN_MS = 5 * 60_000;
// How long a worker isolate caches the set of flagged endpoints before asking
// the metrics DurableObject for a fresh snapshot.
const RPC_HEALTH_SNAPSHOT_TTL_MS = 15_000;
const DEFAULT_RPCS_URL = "https://chainlist.org/rpcs.json";
const DEFAULT_ALCHEMY_NETWORK_CONFIG_URL =
  "https://app-api.alchemy.com/trpc/config.getNetworkConfig";
const INTERNAL_CHAINLIST_CACHE_KEY = "https://rpc-racer.internal/chainlist-rpcs";
const INTERNAL_ALCHEMY_CACHE_KEY = "https://rpc-racer.internal/alchemy-network-config";
const BLOCK_SPEED_STORAGE_KEY = "blockSpeeds";
const BLOCK_SPEED_ATTEMPT_STORAGE_KEY = "blockSpeedAttempts";
// Failed chains are re-attempted once they've been "cold" for this long, so a
// later estimate (e.g. via the Alchemy fallback) can pick them up without
// busy-looping on dead endpoints.
const BLOCK_SPEED_RETRY_MS = 5 * 60_000;
// How long a worker isolate caches the block-speed map before asking the
// metrics DurableObject for a fresh snapshot.
const BLOCK_SPEED_SNAPSHOT_TTL_MS = 30_000;
// How many chains to estimate per refresh pass. Each refresh only fills chains
// that do not yet have a stored value, so this is a bounded, inexpensive job
// that incrementally covers the whole set over time.
const BLOCK_SPEED_BATCH = 30;
const BLOCK_SPEED_CONCURRENCY = 10;
const BLOCK_SPEED_CANDIDATES = 4;
const BLOCK_SPEED_SAMPLES = 5;
const BLOCK_SPEED_STRIDE = 8;
const BLOCK_SPEED_TIMEOUT_MS = 1_200;

const routeSchema = z.object({
  chainId: z.coerce.number().int().positive(),
});

const querySchema = z.object({
  timeoutMs: z.coerce.number().int().min(200).max(10_000).optional(),
  fanoutCount: z.coerce.number().int().min(1).max(MAX_RANDOM_RACE_FANOUT).optional(),
});

const jsonRpcSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: z.unknown().optional(),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
  })
  .passthrough();

const DISALLOWED_RPC_METHOD_PREFIXES = ["alchemy_"];

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
let rpcHealthMemoryCache: { expiresAt: number; blocked: Set<string> } | null = null;
let blockSpeedsMemoryCache: {
  expiresAt: number;
  byChainId: Map<number, number | null>;
  attempts: Map<number, number>;
} | null = null;

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
            chains: "GET /v1/chains",
            chain: "GET /v1/chains/:chainId",
            stats: "GET /stats",
          },
          metrics,
        });
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/chains") {
      return handleListChains({ env, ctx, query: url.searchParams });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      const metrics = await getRpcMetricsSnapshot({ env });
      return jsonResponse({ ok: true, metrics });
    }

    const internalRaceMatch = url.pathname.match(/^\/internal\/v1\/([^/]+)$/);
    if (internalRaceMatch !== null) {
      const provided = request.headers.get("x-internal-secret");
      const expected = env.INTERNAL_SECRET;
      if (!expected || provided === null || provided !== expected) {
        return jsonResponse({ error: "Unauthorized" }, { status: 401 });
      }
      return handleRaceRpc({
        env,
        ctx,
        request,
        chainSelectorRaw: decodeURIComponent(internalRaceMatch[1]),
        query: url.searchParams,
        caller: "internal",
      });
    }

    const chainMatch = url.pathname.match(/^\/v1\/chains\/(\d+)$/);
    if (chainMatch !== null) {
      return handleGetChain({ env, ctx, chainIdRaw: chainMatch[1] });
    }

    const raceMatch = url.pathname.match(/^\/v1\/([^/]+)$/);
    if (raceMatch !== null) {
      return handleRaceRpc({
        env,
        ctx,
        request,
        chainSelectorRaw: decodeURIComponent(raceMatch[1]),
        query: url.searchParams,
        caller: "public",
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

// Returns a positive finite block-speed value as a number for serving, or
// undefined when there's no usable value stored (including the null marker used
// for attempted-but-unestimable chains).
function blockSpeedMsOrUndefined(value: number | null | undefined): number | undefined {
  if (value !== null && typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return undefined;
}

async function handleGetChain({
  env,
  ctx,
  chainIdRaw,
}: {
  env: Env;
  ctx: ExecutionContext;
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

  const blockSpeeds = await readBlockSpeedsMap({ env });
  ctx.waitUntil(refreshBlockSpeeds({ env }));

  const blockSpeedMs = blockSpeedMsOrUndefined(blockSpeeds.byChainId.get(chain.chainId));
  return jsonResponse({
    ...chain,
    ...(blockSpeedMs !== undefined && { blockSpeedMs }),
  });
}

async function handleListChains({
  env,
  ctx,
  query,
}: {
  env: Env;
  ctx: ExecutionContext;
  query: URLSearchParams;
}): Promise<Response> {
  const includeRpcUrls = query.has("includeRpcUrls");
  const registry = await getChainRegistry({ env });
  const blockSpeeds = await readBlockSpeedsMap({ env });
  ctx.waitUntil(refreshBlockSpeeds({ env }));

  const chains = registry.orderedChains.map((chain) => {
    const blockSpeedMs = blockSpeedMsOrUndefined(blockSpeeds.byChainId.get(chain.chainId));
    if (includeRpcUrls) {
      return {
        ...chain,
        ...(blockSpeedMs !== undefined && { blockSpeedMs }),
      };
    }

    return {
      chainId: chain.chainId,
      name: chain.name,
      shortName: chain.shortName,
      chainSlug: chain.chainSlug,
      isTestnet: chain.isTestnet,
      aliases: chain.aliases,
      rpcUrlCount: chain.rpcUrls.length,
      ...(blockSpeedMs !== undefined && { blockSpeedMs }),
    };
  });

  const covered = [...blockSpeeds.byChainId.values()].filter(
    (value) => value !== null && value > 0,
  ).length;

  return jsonResponse({
    total: chains.length,
    covered,
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
  caller,
}: {
  env: Env;
  ctx: ExecutionContext;
  request: Request;
  chainSelectorRaw: string;
  query: URLSearchParams;
  caller: "public" | "internal";
}): Promise<Response> {
  const startedAt = performance.now();
  if (request.method !== "POST") {
    return finalizeRpcResponse({
      env,
      ctx,
      startedAt,
      response: jsonResponse({ error: "Use POST with a JSON-RPC body" }, { status: 405 }),
      fallbackUsed: false,
      caller,
    });
  }

  if (caller === "public") {
    const rateLimitKey = request.headers.get("cf-connecting-ip") ?? "unknown";
    const [burstLimit, sustainedLimit] = await Promise.all([
      env.RPC_BURST_RATE_LIMITER.limit({ key: rateLimitKey }),
      env.RPC_SUSTAINED_RATE_LIMITER.limit({ key: rateLimitKey }),
    ]);
    if (!burstLimit.success || !sustainedLimit.success) {
      const retryAfterSeconds = sustainedLimit.success ? 10 : 60;
      return finalizeRpcResponse({
        env,
        ctx,
        startedAt,
        response: jsonResponse(
          {
            error: "Rate limit exceeded. Contact hi@stupidtech.net if you need higher rate limits.",
          },
          {
            status: 429,
            headers: {
              "retry-after": String(retryAfterSeconds),
            },
          },
        ),
        fallbackUsed: false,
        caller,
      });
    }
  }

  const parsedQuery = querySchema.safeParse({
    timeoutMs: query.get("timeoutMs") ?? undefined,
    fanoutCount: query.get("fanoutCount") ?? undefined,
  });
  if (!parsedQuery.success) {
    return finalizeRpcResponse({
      env,
      ctx,
      startedAt,
      response: jsonResponse({ error: "Invalid query params" }, { status: 400 }),
      fallbackUsed: false,
      caller,
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
      caller,
    });
  }

  // Accept either a single JSON-RPC 2.0 request or a JSON-RPC 2.0 batch (array).
  // A batch is forwarded whole (each item validated) and the array comes back
  // as-is, so a client can collapse many calls into one Worker request.
  let rpcMethod: string;
  let requestBody: string;
  let jsonRpcId: unknown = null;
  if (Array.isArray(parsedBody)) {
    if (parsedBody.length === 0) {
      return finalizeRpcResponse({
        env,
        ctx,
        startedAt,
        response: jsonResponse({ error: "Empty JSON-RPC batch" }, { status: 400 }),
        fallbackUsed: false,
        caller,
      });
    }
    for (const item of parsedBody) {
      const itemRequest = jsonRpcSchema.safeParse(item);
      if (!itemRequest.success || isDisallowedRpcMethod({ method: itemRequest.data.method })) {
        return finalizeRpcResponse({
          env,
          ctx,
          startedAt,
          response: jsonResponse(
            { error: "Batch must contain only supported JSON-RPC 2.0 requests" },
            { status: 400 },
          ),
          fallbackUsed: false,
          caller,
        });
      }
    }
    rpcMethod = "batch";
    requestBody = JSON.stringify(parsedBody);
  } else {
    const validatedBody = jsonRpcSchema.safeParse(parsedBody);
    if (!validatedBody.success) {
      return finalizeRpcResponse({
        env,
        ctx,
        startedAt,
        response: jsonResponse({ error: "Body must be a JSON-RPC 2.0 request" }, { status: 400 }),
        fallbackUsed: false,
        caller,
      });
    }
    rpcMethod = validatedBody.data.method;
    jsonRpcId = validatedBody.data.id ?? null;
    requestBody = JSON.stringify(validatedBody.data);
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
      caller,
    });
  }

  const defaultTimeoutMs = parsePositiveInt({ value: env.DEFAULT_TIMEOUT_MS, fallback: 2_500 });

  if (isDisallowedRpcMethod({ method: rpcMethod })) {
    return finalizeRpcResponse({
      env,
      ctx,
      startedAt,
      response: jsonResponse(
        {
          jsonrpc: "2.0",
          error: {
            code: -32601,
            message: "Provider-specific methods are not supported",
          },
          id: jsonRpcId,
        },
        { status: 400 },
      ),
      fallbackUsed: false,
      caller,
      chainId: chain.chainId,
      method: rpcMethod,
    });
  }

  const timeoutMs = parsedQuery.data.timeoutMs ?? defaultTimeoutMs;
  const fanoutCount = parsedQuery.data.fanoutCount ?? MAX_RANDOM_RACE_FANOUT;

  const blockedUrls = await getBlockedRpcUrls({ env });
  const candidateUrls = selectRandomRpcUrls({
    rpcUrls: chain.rpcUrls,
    count: fanoutCount,
    blockedUrls,
  });
  if (candidateUrls.length === 0) {
    return finalizeRpcResponse({
      env,
      ctx,
      startedAt,
      response: jsonResponse({ error: "No usable HTTP RPC URLs for chain" }, { status: 502 }),
      fallbackUsed: false,
      caller,
      chainId: chain.chainId,
      method: rpcMethod,
    });
  }

  const raceResult = await raceRequests({ candidateUrls, requestBody, timeoutMs });
  const urlResults = raceResult.urlResults;
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
        caller,
        chainId: chain.chainId,
        method: rpcMethod,
        urlResults,
      });
    }

    if (raceResult.errorResponse !== null) {
      const provider = providerFromUrl({ url: raceResult.errorResponse.url });
      const response = new Response(raceResult.errorResponse.body, {
        status: raceResult.errorResponse.status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-rpc-upstream": raceResult.errorResponse.url,
          "x-rpc-provider": provider,
          "x-rpc-chain-id": String(chain.chainId),
          "x-rpc-chain-name": chain.name,
          "x-rpc-alchemy-attempted": String(shouldTryAlchemyFallback),
        },
      });

      return finalizeRpcResponse({
        env,
        ctx,
        startedAt,
        response,
        fallbackUsed: false,
        caller,
        chainId: chain.chainId,
        method: rpcMethod,
        urlResults,
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
        },
        {
          status: 502,
          headers: {
            "x-rpc-alchemy-attempted": String(shouldTryAlchemyFallback),
            "x-rpc-error-source": "upstream",
          },
        },
      ),
      fallbackUsed: false,
      caller,
      chainId: chain.chainId,
      method: rpcMethod,
      urlResults,
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
    caller,
    chainId: chain.chainId,
    method: rpcMethod,
    urlResults,
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
}): Promise<{
  winner: { url: string; body: string; status: number } | null;
  errorResponse: { url: string; body: string; status: number } | null;
  shouldTryAlchemyFallback: boolean;
  urlResults: RpcAttemptHealth[];
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

      const body = await response.text();
      const parsed = safeJsonParse({ value: body });
      if (!isJsonRpcResponse({ value: parsed })) {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        throw new Error("Not a JSON-RPC response");
      }

      const hasJsonRpcError = isJsonRpcError({ value: parsed });
      return {
        url,
        body,
        status: response.status,
        hasJsonRpcError,
        likelyStateIssueError: isLikelyStateIssueError({ value: parsed }),
        degraded: hasJsonRpcError && isDegradedRpcError({ value: parsed }),
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
    let winner: { url: string; body: string; status: number } | null = null;
    let jsonRpcResponsesObserved = 0;
    let jsonRpcErrorsObserved = 0;
    let stateIssueErrorsObserved = 0;
    let degradedErrorsObserved = 0;
    let firstJsonRpcErrorResponse: { url: string; body: string; status: number } | null = null;
    let firstTransportError: string | null = null;

    while (pending.size > 0) {
      const next = await Promise.race([...pending].map((index) => wrapped[index]));
      pending.delete(next.index);

      if (!next.ok) {
        if (firstTransportError === null && !isWinnerAbort({ error: next.error })) {
          firstTransportError = formatAttemptError({ error: next.error });
        }
        continue;
      }

      if (!next.value.hasJsonRpcError) {
        winner = { url: next.value.url, body: next.value.body, status: next.value.status };
        break;
      }

      jsonRpcResponsesObserved += 1;
      jsonRpcErrorsObserved += 1;
      if (firstJsonRpcErrorResponse === null) {
        firstJsonRpcErrorResponse = {
          url: next.value.url,
          body: next.value.body,
          status: next.value.status,
        };
      }
      if (next.value.likelyStateIssueError) {
        stateIssueErrorsObserved += 1;
      }
      if (next.value.degraded) {
        degradedErrorsObserved += 1;
      }

      if (jsonRpcResponsesObserved >= 5 && jsonRpcErrorsObserved >= 5) {
        break;
      }
    }

    abortAll({ controllers });

    // Let every in-flight/won attempt settle so we capture the real verdicts,
    // including rate-limited responses that finished just after the winner was
    // chosen (all winner-aborted fetches reject immediately, so this is cheap).
    await Promise.allSettled(wrapped);

    // Build the full health snapshot from actual outcomes. "Winner aborted"
    // attempts never produced an answer (they just lost the race), so they carry
    // no health signal either way and are excluded from the tally.
    const urlResults: RpcAttemptHealth[] = [];
    for (const outcome of wrapped) {
      const settled = await outcome;
      if (settled.ok) {
        urlResults.push({ url: settled.value.url, degraded: settled.value.degraded });
      } else if (!isWinnerAbort({ error: settled.error })) {
        urlResults.push({ url: candidateUrls[settled.index], degraded: true });
      }
    }

    let failure: { message: string } | undefined;
    if (winner === null) {
      if (firstJsonRpcErrorResponse !== null) {
        failure = { message: "All upstream RPCs returned errors" };
      } else if (firstTransportError !== null) {
        failure = { message: firstTransportError };
      }
    }

    return {
      winner,
      errorResponse: firstJsonRpcErrorResponse,
      shouldTryAlchemyFallback: stateIssueErrorsObserved > 0 || degradedErrorsObserved > 0,
      urlResults,
      ...(failure !== undefined && { failure }),
    };
  } catch (error) {
    abortAll({ controllers });
    void error;
    return {
      winner: null,
      errorResponse: null,
      shouldTryAlchemyFallback: false,
      urlResults: [],
      failure: {
        message: "RPC race failed unexpectedly",
      },
    };
  }
}

// True when an attempt was cancelled because another provider won the race
// ("Winner selected" abort), so this endpoint never produced a response and
// should not be counted against its health. Real transport failures, timeouts,
// and explicit provider errors are separate and DO count.
function isWinnerAbort({ error }: { error: unknown }): boolean {
  if (error instanceof Error) {
    if (/winner selected/i.test(error.message)) {
      return true;
    }
    // Some runtimes expose the abort reason separately.
    const reason = (error as Error & { reason?: unknown; cause?: unknown }).reason;
    const cause = (error as Error & { reason?: unknown; cause?: unknown }).cause;
    const detail =
      typeof reason === "string" || typeof cause === "string"
        ? `${reason ?? ""} ${cause ?? ""}`
        : "";
    if (/winner selected/i.test(detail)) {
      return true;
    }
  }
  return false;
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

function selectRandomRpcUrls({
  rpcUrls,
  count,
  blockedUrls,
}: {
  rpcUrls: string[];
  count: number;
  blockedUrls: Set<string>;
}): string[] {
  const healthy = rpcUrls.filter((url) => !blockedUrls.has(url));
  const selected = shuffleRpcUrls({ urls: healthy }).slice(0, count);

  if (selected.length < count) {
    const blocked = rpcUrls.filter((url) => blockedUrls.has(url));
    for (const url of shuffleRpcUrls({ urls: blocked })) {
      if (selected.length >= count) {
        break;
      }
      if (!selected.includes(url)) {
        selected.push(url);
      }
    }
  }

  return selected;
}

function shuffleRpcUrls({ urls }: { urls: string[] }): string[] {
  const shuffled = [...urls];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }
  return shuffled;
}

// Returns the set of upstream RPC URLs currently in a failed-cooldown, using a
// short-lived isolate cache so we don't hit the metrics DurableObject on every
// request. Degrades gracefully to an empty set if metrics are unreachable.
async function getBlockedRpcUrls({ env }: { env: Env }): Promise<Set<string>> {
  const now = Date.now();
  if (rpcHealthMemoryCache !== null && now < rpcHealthMemoryCache.expiresAt) {
    return rpcHealthMemoryCache.blocked;
  }

  const blocked = new Set<string>();
  try {
    const stub = env.METRICS_DO.get(env.METRICS_DO.idFromName("global"));
    const response = await stub.fetch("https://metrics.internal/rpc-health");
    if (response.ok) {
      const snapshot = (await response.json()) as { blocked: Record<string, number> };
      for (const [url, blockedUntil] of Object.entries(snapshot.blocked)) {
        if (blockedUntil > now) {
          blocked.add(url);
        }
      }
    }
  } catch {
    // Fall through with an empty blocked set; we'll retry on the next request.
  }

  rpcHealthMemoryCache = {
    expiresAt: now + RPC_HEALTH_SNAPSHOT_TTL_MS,
    blocked,
  };
  return blocked;
}

function isDisallowedRpcMethod({ method }: { method: string }): boolean {
  return DISALLOWED_RPC_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
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
  if (Array.isArray(value)) {
    // JSON-RPC 2.0 batch: at least one entry, every entry a 2.0 response.
    if (value.length === 0) return false;
    return value.every((entry) => {
      return (
        typeof entry === "object" &&
        entry !== null &&
        (entry as { jsonrpc?: unknown }).jsonrpc === "2.0"
      );
    });
  }

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

// True when a JSON-RPC error is a provider-level "this endpoint won't serve you"
// signal (auth / API-key / rate-limit / paywall) rather than a genuine node-level
// answer (like `execution reverted`). Only these count against an endpoint's
// health; honest reverted errors do not.
function isDegradedRpcError({ value }: { value: unknown }): boolean {
  if (!isJsonRpcError({ value })) {
    return false;
  }

  const candidate = value as {
    error?: {
      code?: unknown;
      message?: unknown;
      data?: unknown;
    };
  };

  if (typeof candidate.error?.code === "number") {
    // Provider-level "you can't use this" codes: 429 (rate limit), 403
    // (forbidden), and the common negative "limit exceeded" codes from
    // Infura/Alchemy/Pokt-style gateways.
    if (candidate.error.code === 403 || candidate.error.code === 429) {
      return true;
    }
    if (candidate.error.code === -32005 || candidate.error.code === -32006) {
      return true;
    }
  }

  const message =
    typeof candidate.error?.message === "string" ? candidate.error.message.toLowerCase() : "";
  const data = typeof candidate.error?.data === "string" ? candidate.error.data.toLowerCase() : "";
  const combined = `${message} ${data}`;

  return (
    /\bauth\b/.test(combined) ||
    /api\s?key/.test(combined) ||
    /\bauthentication\b/.test(combined) ||
    /\bforbidden\b/.test(combined) ||
    /not authorized/.test(combined) ||
    /rate ?limit/.test(combined) ||
    /too many requests/.test(combined) ||
    /request ?limit/.test(combined) ||
    /(?:exceeded|exceeds|reached|reach) .*(?:limit|cap|budget)/.test(combined) ||
    /limit (?:exceeded|reached)/.test(combined) ||
    /slow\s?down/.test(combined) ||
    /frequency (?:too|is too) high/.test(combined) ||
    /allowance (?:exceeded|insufficient|spent)/.test(combined) ||
    /daily (?:request )?limit/.test(combined) ||
    /\bsubscription\b/.test(combined) ||
    /\bpayment\b/.test(combined) ||
    /\bquota\b/.test(combined) ||
    /\bthrottled\b/.test(combined) ||
    /\bdenied\b/.test(combined) ||
    /\brestricted\b/.test(combined) ||
    /credit (?:limit|exhausted|insufficient)/.test(combined) ||
    /needs?\s+an account/.test(combined) ||
    /requires?\s+an account/.test(combined)
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

// Reads the persisted chain->blockSpeedMs map, using a short-lived isolate
// cache so we don't query the metrics DurableObject on every listing. Degrades
// to an empty map if metrics are unreachable.
async function readBlockSpeedsMap({
  env,
}: {
  env: Env;
}): Promise<{ byChainId: Map<number, number | null>; attempts: Map<number, number> }> {
  const now = Date.now();
  if (blockSpeedsMemoryCache !== null && now < blockSpeedsMemoryCache.expiresAt) {
    return {
      byChainId: blockSpeedsMemoryCache.byChainId,
      attempts: blockSpeedsMemoryCache.attempts,
    };
  }

  const byChainId = new Map<number, number | null>();
  const attempts = new Map<number, number>();
  try {
    const stub = env.METRICS_DO.get(env.METRICS_DO.idFromName("global"));
    const response = await stub.fetch("https://metrics.internal/block-speeds");
    if (response.ok) {
      const payload = (await response.json()) as {
        blockSpeeds?: Record<string, number | null>;
        attempts?: Record<string, number>;
      };
      for (const [chainIdRaw, milliseconds] of Object.entries(payload.blockSpeeds ?? {})) {
        const chainId = Number.parseInt(chainIdRaw, 10);
        if (Number.isFinite(chainId) && (milliseconds === null || Number.isFinite(milliseconds))) {
          byChainId.set(chainId, milliseconds);
        }
      }
      for (const [chainIdRaw, attemptedAt] of Object.entries(payload.attempts ?? {})) {
        const chainId = Number.parseInt(chainIdRaw, 10);
        if (Number.isFinite(chainId) && Number.isFinite(attemptedAt)) {
          attempts.set(chainId, attemptedAt);
        }
      }
    }
  } catch {
    // Fall through with empty maps; retry on the next request.
  }

  blockSpeedsMemoryCache = { expiresAt: now + BLOCK_SPEED_SNAPSHOT_TTL_MS, byChainId, attempts };
  return { byChainId, attempts };
}

async function writeBlockSpeed({
  env,
  chainId,
  milliseconds,
}: {
  env: Env;
  chainId: number;
  milliseconds: number | null;
}): Promise<void> {
  try {
    const stub = env.METRICS_DO.get(env.METRICS_DO.idFromName("global"));
    await stub.fetch("https://metrics.internal/block-speed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ chainId, milliseconds }),
    });
    // Invalidate the isolate cache so a follow-up listing sees fresh values.
    blockSpeedsMemoryCache = null;
  } catch {
    // Best-effort: a failed write is retried on the next refresh pass.
  }
}

// Estimates block speed (avg milliseconds between blocks) for a chain. Tries a
// small fanout of the chain's own public RPC endpoints first, then Alchemy's
// node for this chain (via the network slug map) as a reliable fallback for
// chains whose free public RPCs are unusable. The first source that produces a
// valid result wins. Returns null when no source serves a usable answer.
async function computeChainBlockSpeedMs({
  env,
  chainId,
  rpcUrls,
}: {
  env: Env;
  chainId: number;
  rpcUrls: string[];
}): Promise<number | null> {
  const candidates: string[] = [];
  for (const url of shuffleRpcUrls({ urls: rpcUrls }).slice(0, BLOCK_SPEED_CANDIDATES)) {
    candidates.push(url);
  }

  const alchemyUrl = await alchemyChainUrl({ env, chainId });
  if (alchemyUrl !== null) {
    candidates.push(alchemyUrl);
  }

  for (const url of candidates) {
    const milliseconds = await tryComputeBlockSpeedMs({ url });
    if (milliseconds !== null) {
      return milliseconds;
    }
  }
  return null;
}

// Builds the Alchemy JSON-RPC URL for a chain id, or null when there's no API
// key configured or the chain isn't served by the Alchemy node API.
async function alchemyChainUrl({
  env,
  chainId,
}: {
  env: Env;
  chainId: number;
}): Promise<string | null> {
  const apiKey = env.ALCHEMY_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return null;
  }
  try {
    const slugByChainId = await getAlchemyNetworkSlugMap({ env });
    const slug = slugByChainId.get(chainId);
    if (slug === undefined) {
      return null;
    }
    return `https://${slug}.g.alchemy.com/v2/${apiKey}`;
  } catch {
    return null;
  }
}

async function tryComputeBlockSpeedMs({ url }: { url: string }): Promise<number | null> {
  let latestHeight: bigint;
  try {
    const latest = await rpcFetch({
      url,
      method: "eth_blockNumber",
      params: [],
      timeoutMs: BLOCK_SPEED_TIMEOUT_MS,
    });
    if (typeof latest?.result !== "string" || !latest.result.startsWith("0x")) {
      return null;
    }
    latestHeight = BigInt(latest.result);
  } catch {
    return null;
  }

  const timestamps: number[] = [];
  for (let index = 0; index < BLOCK_SPEED_SAMPLES; index += 1) {
    const height = latestHeight - BigInt(index) * BigInt(BLOCK_SPEED_STRIDE);
    try {
      const block = await rpcFetch({
        url,
        method: "eth_getBlockByNumber",
        params: [`0x${height.toString(16)}`, false],
        timeoutMs: BLOCK_SPEED_TIMEOUT_MS,
      });
      const raw =
        block !== null && typeof block.result === "object" && block.result !== null
          ? (block.result as { timestamp?: unknown }).timestamp
          : undefined;
      if (typeof raw === "string" && raw.startsWith("0x")) {
        timestamps.push(Number(BigInt(raw)));
      }
    } catch {
      // tolerate individual block read failures
    }
  }

  if (timestamps.length < 2) {
    return null;
  }

  const newest = timestamps[0];
  const oldest = timestamps[timestamps.length - 1];
  const spanSeconds = newest - oldest;
  const spanBlocks = (BLOCK_SPEED_SAMPLES - 1) * BLOCK_SPEED_STRIDE;
  if (spanSeconds <= 0 || spanBlocks <= 0) {
    return null;
  }
  return Math.round((spanSeconds / spanBlocks) * 1000);
}

async function rpcFetch({
  url,
  method,
  params,
  timeoutMs,
}: {
  url: string;
  method: string;
  params: unknown[];
  timeoutMs: number;
}): Promise<{ result?: unknown } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Block speed timeout"), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: "block-speed" }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as { result?: unknown; error?: unknown };
    if (payload.error !== undefined) {
      return null;
    }
    return payload;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Incrementally refreshes the persisted block-speed map, estimating only chains
// that do not yet have a stored value. Bounded to a small batch per call so it
// runs cheaply in a background waitUntil; repeated requests gradually cover the
// full chain set.
async function refreshBlockSpeeds({ env }: { env: Env }): Promise<void> {
  try {
    const now = Date.now();
    const [current, registry] = await Promise.all([
      readBlockSpeedsMap({ env }),
      getChainRegistry({ env }),
    ]);

    const missing = registry.orderedChains
      .filter((chain) => {
        const value = current.byChainId.get(chain.chainId);
        if (value !== undefined && value !== null) {
          return false; // already has a stored value
        }
        // A previously-failed chain is retried once its attempt has gone cold,
        // so later sources (e.g. the Alchemy fallback) can pick it up without
        // busy-looping on dead endpoints.
        const attemptedAt = current.attempts.get(chain.chainId) ?? 0;
        if (value === null && now - attemptedAt < BLOCK_SPEED_RETRY_MS) {
          return false;
        }
        return true;
      })
      .slice(0, BLOCK_SPEED_BATCH);

    if (missing.length === 0) {
      return;
    }

    await mapWithConcurrency({
      items: missing,
      concurrency: BLOCK_SPEED_CONCURRENCY,
      worker: async (chain) => {
        const milliseconds = await computeChainBlockSpeedMs({
          env,
          chainId: chain.chainId,
          rpcUrls: chain.rpcUrls,
        });
        // Store the value, or a null marker so a failed chain isn't retried on
        // every pass (which would otherwise stall the sweep on dead endpoints).
        await writeBlockSpeed({ env, chainId: chain.chainId, milliseconds });
      },
    });
  } catch {
    // Best-effort background job: failures are retried on the next request.
  }
}

async function mapWithConcurrency<T, R>({
  items,
  concurrency,
  worker,
}: {
  items: T[];
  concurrency: number;
  worker: (item: T) => Promise<R>;
}): Promise<R[]> {
  let nextIndex = 0;
  const outputs = await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      const acc: R[] = [];
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return acc;
        }
        acc.push(await worker(items[index]));
      }
    }),
  );
  return outputs.flat();
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
  urlResults,
  caller = "public",
}: {
  env: Env;
  ctx: ExecutionContext;
  startedAt: number;
  response: Response;
  fallbackUsed: boolean;
  chainId?: number;
  method?: string;
  urlResults?: RpcAttemptHealth[];
  caller?: "public" | "internal";
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
    caller,
    urlResults,
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

function defaultCounters(): MetricsCounters {
  const {
    requestsServed,
    fallbackResponses,
    latencySumMs,
    latencyCount,
    latencyMaxMs,
    latencyBuckets,
  } = defaultMetricsSnapshot();
  return {
    requestsServed,
    fallbackResponses,
    latencySumMs,
    latencyCount,
    latencyMaxMs,
    latencyBuckets,
  };
}

function normalizeCounters({ counters }: { counters: Partial<MetricsCounters> }): MetricsCounters {
  const defaults = defaultCounters();
  return {
    requestsServed: Math.max(0, Math.trunc(counters.requestsServed ?? 0)),
    fallbackResponses: Math.max(0, Math.trunc(counters.fallbackResponses ?? 0)),
    latencySumMs: Math.max(0, counters.latencySumMs ?? 0),
    latencyCount: Math.max(0, Math.trunc(counters.latencyCount ?? 0)),
    latencyMaxMs: Math.max(0, counters.latencyMaxMs ?? 0),
    latencyBuckets: {
      ...defaults.latencyBuckets,
      ...counters.latencyBuckets,
    },
  };
}

function samplesStorageKey({ chainId, method }: { chainId: number; method: string }): string {
  return `${SAMPLES_KEY_PREFIX}${chainId}:${method}`;
}

function parseSamplesStorageKey({
  key,
}: {
  key: string;
}): { chainId: string; method: string } | null {
  const raw = key.slice(SAMPLES_KEY_PREFIX.length);
  const separatorIndex = raw.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  return {
    chainId: raw.slice(0, separatorIndex),
    method: raw.slice(separatorIndex + 1),
  };
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
        .filter(([method]) => !isDisallowedRpcMethod({ method }))
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

    if (request.method === "GET" && url.pathname === "/rpc-health") {
      const health = await this.readRpcHealth();
      const now = Date.now();
      const blocked: Record<string, number> = {};
      for (const [rpcUrl, entry] of Object.entries(health)) {
        if (entry.blockedUntil > now) {
          blocked[rpcUrl] = entry.blockedUntil;
        }
      }
      return jsonResponse({ blocked });
    }

    if (request.method === "GET" && url.pathname === "/block-speeds") {
      const [blockSpeeds, attempts] = await Promise.all([
        this.readBlockSpeeds(),
        this.readBlockSpeedAttempts(),
      ]);
      return jsonResponse({ blockSpeeds, attempts, computedAt: Date.now() });
    }

    if (request.method === "POST" && url.pathname === "/block-speed") {
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return jsonResponse({ error: "Invalid block speed payload" }, { status: 400 });
      }
      const { chainId, milliseconds } = payload as { chainId?: unknown; milliseconds?: unknown };
      if (
        typeof chainId !== "number" ||
        !Number.isInteger(chainId) ||
        (milliseconds !== null &&
          (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds <= 0))
      ) {
        return jsonResponse({ error: "Invalid chainId or milliseconds" }, { status: 400 });
      }
      const blockSpeeds = await this.readBlockSpeeds();
      blockSpeeds[chainId] = milliseconds as number | null;
      await this.state.storage.put(BLOCK_SPEED_STORAGE_KEY, blockSpeeds);

      const attempts = await this.readBlockSpeedAttempts();
      attempts[chainId] = Date.now();
      await this.state.storage.put(BLOCK_SPEED_ATTEMPT_STORAGE_KEY, attempts);
      return jsonResponse({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/record") {
      let record: RpcMetricsRecord;
      try {
        record = (await request.json()) as RpcMetricsRecord;
      } catch {
        return jsonResponse({ error: "Invalid metrics payload" }, { status: 400 });
      }

      if (record.urlResults !== undefined && record.urlResults.length > 0) {
        await this.recordRpcHealth({ urlResults: record.urlResults });
      }

      const counters = await this.readCounters();
      counters.requestsServed += Math.max(0, Math.trunc(record.requestCount));
      counters.fallbackResponses += Math.max(0, Math.trunc(record.fallbackCount));

      const latencySampleCount = Math.max(0, Math.trunc(record.latencySampleCount));
      if (latencySampleCount > 0) {
        const latencyMs = Math.max(0, record.latencyMs);
        counters.latencyCount += latencySampleCount;
        counters.latencySumMs += latencyMs;
        counters.latencyMaxMs = Math.max(counters.latencyMaxMs, latencyMs);

        const bucket = latencyBucket({ latencyMs });
        counters.latencyBuckets[bucket] = (counters.latencyBuckets[bucket] ?? 0) + 1;

        if (record.chainId !== undefined && record.method !== undefined) {
          await this.appendLatencySample({
            chainId: record.chainId,
            method: record.method,
            latencyMs,
          });
        }
      }

      await this.state.storage.put(COUNTERS_STORAGE_KEY, counters);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Not found" }, { status: 404 });
  }

  private async readSnapshot(): Promise<MetricsStorageSnapshot> {
    await this.migrateLegacySnapshot();
    const counters = await this.readCounters();
    const chainMethodLatencySamples = await this.readChainMethodLatencySamples();
    return { ...counters, chainMethodLatencySamples };
  }

  private async migrateLegacySnapshot(): Promise<void> {
    const legacy = await this.state.storage.get<MetricsStorageSnapshot>("snapshot");
    if (legacy === undefined) {
      return;
    }

    await this.state.storage.put(COUNTERS_STORAGE_KEY, normalizeCounters({ counters: legacy }));

    for (const [chainId, methods] of Object.entries(legacy.chainMethodLatencySamples ?? {})) {
      for (const [method, samples] of Object.entries(methods)) {
        await this.state.storage.put(
          samplesStorageKey({ chainId: Number.parseInt(chainId, 10), method }),
          samples,
        );
      }
    }

    await this.state.storage.delete("snapshot");
  }

  private async readCounters(): Promise<MetricsCounters> {
    const stored = await this.state.storage.get<Partial<MetricsCounters>>(COUNTERS_STORAGE_KEY);
    if (stored !== undefined) {
      return normalizeCounters({ counters: stored });
    }

    const initial = defaultCounters();
    await this.state.storage.put(COUNTERS_STORAGE_KEY, initial);
    return initial;
  }

  private async readRpcHealth(): Promise<RpcHealthMap> {
    const stored = await this.state.storage.get<RpcHealthMap>(RPC_HEALTH_STORAGE_KEY);
    return stored ?? {};
  }

  private async readBlockSpeeds(): Promise<Record<number, number | null>> {
    const stored =
      await this.state.storage.get<Record<number, number | null>>(BLOCK_SPEED_STORAGE_KEY);
    return stored ?? {};
  }

  private async readBlockSpeedAttempts(): Promise<Record<number, number>> {
    const stored = await this.state.storage.get<Record<number, number>>(
      BLOCK_SPEED_ATTEMPT_STORAGE_KEY,
    );
    return stored ?? {};
  }

  private async recordRpcHealth({ urlResults }: { urlResults: RpcAttemptHealth[] }): Promise<void> {
    const health = await this.readRpcHealth();
    const now = Date.now();
    let changed = false;

    for (const result of urlResults) {
      let entry = health[result.url];
      if (entry === undefined) {
        entry = { consecutiveFailures: 0, blockedUntil: 0 };
      }

      if (result.degraded) {
        entry.consecutiveFailures += 1;
        if (entry.consecutiveFailures >= RPC_HEALTH_FAIL_THRESHOLD) {
          // Re-slide the cooldown while the endpoint keeps failing so a
          // permanently paywalled endpoint stays out.
          entry.blockedUntil = now + RPC_HEALTH_COOLDOWN_MS;
        }
      } else {
        // A healthy (even if honestly reverted) answer means the endpoint is
        // serving requests again: recover it immediately.
        entry.consecutiveFailures = 0;
        entry.blockedUntil = 0;
      }

      health[result.url] = entry;
      changed = true;
    }

    if (changed) {
      // Opportunistically drop entries with no failures and an expired window to
      // avoid unbounded growth.
      for (const [rpcUrl, entry] of Object.entries(health)) {
        if (entry.consecutiveFailures === 0 && entry.blockedUntil <= now) {
          delete health[rpcUrl];
        }
      }
      await this.state.storage.put(RPC_HEALTH_STORAGE_KEY, health);
    }
  }

  private async readChainMethodLatencySamples(): Promise<ChainMethodLatencySamples> {
    const samples: ChainMethodLatencySamples = {};
    const entries = await this.state.storage.list<number[]>({ prefix: SAMPLES_KEY_PREFIX });
    for (const [key, values] of entries) {
      const parsed = parseSamplesStorageKey({ key });
      if (parsed === null) {
        continue;
      }
      samples[parsed.chainId] ??= {};
      samples[parsed.chainId][parsed.method] = values;
    }
    return samples;
  }

  private async appendLatencySample({
    chainId,
    method,
    latencyMs,
  }: {
    chainId: number;
    method: string;
    latencyMs: number;
  }): Promise<void> {
    const key = samplesStorageKey({ chainId, method });
    const existing = await this.state.storage.get<number[]>(key);
    const samples = existing ?? [];
    samples.push(Math.max(0, latencyMs));
    if (samples.length > MAX_CHAIN_METHOD_LATENCY_SAMPLES) {
      samples.splice(0, samples.length - MAX_CHAIN_METHOD_LATENCY_SAMPLES);
    }
    await this.state.storage.put(key, samples);
  }
}
