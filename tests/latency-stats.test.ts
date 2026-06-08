import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  appendChainMethodLatencySample,
  buildChainMethodLatencyStats,
  type ChainMethodLatencySamples,
} from "../src/index.ts";

describe("chain/method latency tracking", () => {
  it("keeps only the last 1000 latency samples per method per chain", () => {
    const samples: ChainMethodLatencySamples = {};

    for (let latencyMs = 1; latencyMs <= 1005; latencyMs += 1) {
      appendChainMethodLatencySample({
        samples,
        chainId: 1,
        method: "eth_blockNumber",
        latencyMs,
      });
    }

    assert.equal(samples["1"]?.eth_blockNumber?.length, 1000);
    assert.equal(samples["1"]?.eth_blockNumber?.[0], 6);
    assert.equal(samples["1"]?.eth_blockNumber?.[999], 1005);
  });

  it("tracks methods independently per chain and reports average and median", () => {
    const samples: ChainMethodLatencySamples = {};

    appendChainMethodLatencySample({ samples, chainId: 8453, method: "eth_call", latencyMs: 30 });
    appendChainMethodLatencySample({ samples, chainId: 8453, method: "eth_call", latencyMs: 10 });
    appendChainMethodLatencySample({ samples, chainId: 8453, method: "eth_call", latencyMs: 20 });
    appendChainMethodLatencySample({
      samples,
      chainId: 8453,
      method: "eth_blockNumber",
      latencyMs: 4,
    });
    appendChainMethodLatencySample({ samples, chainId: 1, method: "eth_call", latencyMs: 100 });

    assert.deepEqual(buildChainMethodLatencyStats({ samples }), [
      {
        chainId: 1,
        methods: [
          {
            method: "eth_call",
            sampleCount: 1,
            averageLatencyMs: 100,
            medianLatencyMs: 100,
          },
        ],
      },
      {
        chainId: 8453,
        methods: [
          {
            method: "eth_blockNumber",
            sampleCount: 1,
            averageLatencyMs: 4,
            medianLatencyMs: 4,
          },
          {
            method: "eth_call",
            sampleCount: 3,
            averageLatencyMs: 20,
            medianLatencyMs: 20,
          },
        ],
      },
    ]);
  });
});
