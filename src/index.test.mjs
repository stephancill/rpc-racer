import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { raceRequests } from "./index.ts";

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
    test(`HTTP ${status} enables fallback even with a generic JSON-RPC error`, async () => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Internal error" },
      });
      mockUpstreams({ body, status });

      const result = await runRace();

      expect(result.winner).toBeNull();
      expect(result.errorResponse).toEqual({ url: failingUrl, body, status });
      expect(result.shouldTryAlchemyFallback).toBe(true);
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
});
