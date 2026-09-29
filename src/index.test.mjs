import { afterEach, describe, expect, spyOn, test } from "bun:test";
import worker, { raceRequests } from "./index.ts";

const failingUrl = "https://failing.example";
const healthyUrl = "https://healthy.example";
const address = "0x000000000000000000000000000000000000dead";
const nativeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "eth_getBalance",
  params: [address, "latest"],
};
const tokenRequest = {
  jsonrpc: "2.0",
  id: 2,
  method: "eth_call",
  params: [
    {
      to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      data: `0x70a08231${address.slice(2).padStart(64, "0")}`,
    },
    "latest",
  ],
};

let fetchSpy;
afterEach(() => fetchSpy?.mockRestore());

function responseBody({ payload, result }) {
  const respond = (request) => ({
    jsonrpc: "2.0",
    id: request.id,
    result: result ?? (request.method === "eth_call" ? `0x${"0".repeat(63)}1` : "0x1"),
  });
  return JSON.stringify(Array.isArray(payload) ? payload.map(respond) : respond(payload));
}

function mockUpstreams({ body, status, healthyBody }) {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (url === failingUrl) {
      return new Response(body, { status });
    }
    if (url === healthyUrl && healthyBody !== undefined) {
      // The failed-status response must arrive before this healthy candidate.
      await Bun.sleep(10);
      init.signal.throwIfAborted();
      return new Response(healthyBody, { status: 200 });
    }
    throw new Error(`Unexpected upstream: ${url}`);
  });
}

function runRace({ payload = nativeRequest, withHealthy = false } = {}) {
  return raceRequests({
    candidateUrls: withHealthy ? [failingUrl, healthyUrl] : [failingUrl],
    requestBody: JSON.stringify(payload),
    timeoutMs: 1000,
  });
}

describe("RPC race HTTP failures", () => {
  for (const { name, payload } of [
    { name: "eth_getBalance", payload: nativeRequest },
    { name: "USDC balanceOf", payload: tokenRequest },
    { name: "a mixed batch", payload: [nativeRequest, tokenRequest] },
  ]) {
    test(`a fast malformed 503 cannot beat a healthy response for ${name}`, async () => {
      const healthyBody = responseBody({ payload });
      mockUpstreams({
        body: responseBody({ payload, result: { code: 503, message: "server unavailable" } }),
        status: 503,
        healthyBody,
      });

      const result = await runRace({ payload, withHealthy: true });

      expect(result.winner).toEqual({ url: healthyUrl, body: healthyBody, status: 200 });
      expect(result.errorResponse).toBeNull();
      expect(result.urlResults).toEqual([
        { url: failingUrl, degraded: true },
        { url: healthyUrl, degraded: false },
      ]);
    });
  }

  test("a malformed 503 enables Alchemy fallback and degrades the provider", async () => {
    mockUpstreams({
      body: responseBody({
        payload: nativeRequest,
        result: { code: 503, message: "server unavailable" },
      }),
      status: 503,
    });

    const result = await runRace();

    expect(result.winner).toBeNull();
    expect(result.errorResponse).toBeNull();
    expect(result.shouldTryAlchemyFallback).toBe(true);
    expect(result.failure).toEqual({ message: "HTTP 503" });
    expect(result.urlResults).toEqual([{ url: failingUrl, degraded: true }]);
  });

  test("even a valid-looking result cannot win with a failed HTTP status", async () => {
    mockUpstreams({
      body: responseBody({ payload: nativeRequest, result: "0x1" }),
      status: 429,
    });

    const result = await runRace();

    expect(result.winner).toBeNull();
    expect(result.shouldTryAlchemyFallback).toBe(true);
    expect(result.urlResults).toEqual([{ url: failingUrl, degraded: true }]);
  });

  for (const status of [401, 403, 429, 500, 503]) {
    test(`HTTP ${status} enables fallback without passing through a generic provider error`, async () => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" },
      });
      mockUpstreams({ body, status });

      const result = await runRace();

      expect(result.winner).toBeNull();
      expect(result.errorResponse).toBeNull();
      expect(result.shouldTryAlchemyFallback).toBe(true);
      expect(result.failure).toEqual({ message: "All upstream RPCs returned errors" });
      expect(result.urlResults).toEqual([{ url: failingUrl, degraded: true }]);
    });
  }

  for (const status of [200, 400]) {
    test(`preserves genuine JSON-RPC errors at HTTP ${status} without degrading the provider`, async () => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        error: { code: 3, message: "execution reverted", data: "0x" },
      });
      mockUpstreams({ body, status });

      const result = await runRace({ payload: tokenRequest });

      expect(result.winner).toBeNull();
      expect(result.errorResponse).toEqual({ url: failingUrl, body, status });
      expect(result.shouldTryAlchemyFallback).toBe(false);
      expect(result.urlResults).toEqual([{ url: failingUrl, degraded: false }]);
    });
  }

  test("a fast upstream rate limit does not mask a genuine RPC error", async () => {
    const rateLimitBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32005, message: "rate limit exceeded" },
    });
    const transactionNotFoundBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "transaction not found" },
    });
    mockUpstreams({ body: rateLimitBody, status: 200, healthyBody: transactionNotFoundBody });

    const result = await runRace({ withHealthy: true });

    expect(result.winner).toBeNull();
    expect(result.errorResponse).toEqual({
      url: healthyUrl,
      body: transactionNotFoundBody,
      status: 200,
    });
    expect(result.shouldTryAlchemyFallback).toBe(true);
    expect(result.urlResults).toEqual([
      { url: failingUrl, degraded: true },
      { url: healthyUrl, degraded: false },
    ]);
  });

  test("a provider throttle is not returned when all upstreams are degraded", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32005, message: "rate limit exceeded" },
    });
    mockUpstreams({ body, status: 200 });

    const result = await runRace();

    expect(result.errorResponse).toBeNull();
    expect(result.shouldTryAlchemyFallback).toBe(true);
    expect(result.failure).toEqual({ message: "All upstream RPCs returned errors" });
    expect(result.urlResults).toEqual([{ url: failingUrl, degraded: true }]);
  });

  test("Tatum's paid-plan eth_call denial is degraded even without a subscription message", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -16401, message: "Method 'eth_call' is available for paid plans only." },
    });
    mockUpstreams({ body, status: 200 });

    const result = await runRace({ payload: tokenRequest });

    expect(result.winner).toBeNull();
    expect(result.errorResponse).toBeNull();
    expect(result.shouldTryAlchemyFallback).toBe(true);
    expect(result.urlResults).toEqual([{ url: failingUrl, degraded: true }]);
  });
});

test("the public endpoint fails when public and fallback providers deny access", async () => {
  const originalCaches = globalThis.caches;
  globalThis.caches = {
    default: { match: async () => undefined, put: async () => {} },
  };
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (url === "https://chainlist.example/rpcs.json") {
      return Response.json([
        { chainId: 8453, name: "Base", rpc: [{ url: "https://base-mainnet.gateway.tatum.io" }] },
      ]);
    }
    if (url === "https://base-mainnet.gateway.tatum.io") {
      return Response.json({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -16401, message: "Method 'eth_call' is available for paid plans only." },
      });
    }
    if (url === "https://config.example/networks") {
      return Response.json({
        result: {
          data: [
            { networkChainId: 8453, kebabCaseId: "base-mainnet", supportedProducts: ["node-api"] },
          ],
        },
      });
    }
    if (url === "https://base-mainnet.g.alchemy.com/v2/test-key") {
      return Response.json({
        jsonrpc: "2.0",
        id: 2,
        error: { code: 429, message: "Monthly capacity limit exceeded" },
      });
    }
    throw new Error(`Unexpected upstream: ${url}`);
  });

  try {
    const env = {
      CHAINLIST_RPCS_URL: "https://chainlist.example/rpcs.json",
      ALCHEMY_NETWORK_CONFIG_URL: "https://config.example/networks",
      ALCHEMY_API_KEY: "test-key",
      RPC_BURST_RATE_LIMITER: { limit: async () => ({ success: true }) },
      METRICS_DO: {
        idFromName: () => "global",
        get: () => ({ fetch: async () => Response.json({ blocked: {} }) }),
      },
    };
    const response = await worker.fetch(
      new Request("https://evm.stupidtech.net/v1/8453", {
        method: "POST",
        body: JSON.stringify(tokenRequest),
      }),
      env,
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("x-rpc-error-source")).toBe("upstream");
    expect(response.headers.get("x-rpc-alchemy-attempted")).toBe("true");
    expect(await response.json()).toEqual({
      error: "All upstream RPCs returned errors",
      chainId: 8453,
      tried: 1,
    });
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
