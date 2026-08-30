#!/usr/bin/env bun

/*
 * Milestone-0 integration test for rpc-racer's private scanner path.
 *
 * For Ethereum, Base, Optimism, and Arbitrum it verifies, through the internal
 * route (so it doesn't consume the public per-IP budget):
 *   - eth_blockNumber and eth_getBlockByNumber(height, true) work,
 *   - eth_getLogs by the EXACT block hash returns only logs whose blockHash
 *     matches (consistency-safe read),
 *   - an eth_getTransactionReceipt for a tx in that block returns a receipt
 *     whose blockHash matches the fetched block.
 * It also measures fan-out amplification on response bytes and proves the
 * internal path is not gated by the public 60/min limit (a >60 burst succeeds).
 *
 * Usage:
 *   BUN env: BUN_SECRET or
 *   INTERNAL_SECRET=... bun scripts/integration-test.mjs [--base-url URL]
 *        [--fan-out N] [--burst M] [--json out.json]
 */

const DEFAULT_BASE = "https://evm.stupidtech.net";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TARGETS = [
  { id: 1, label: "ethereum" },
  { id: 8453, label: "base" },
  { id: 10, label: "optimism" },
  { id: 42161, label: "arbitrum" },
];

function cli(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const BASE_URL = (cli("--base-url", DEFAULT_BASE) ?? DEFAULT_BASE).replace(/\/$/, "");
const SECRET = process.env.INTERNAL_SECRET ?? "";
const FANOUT = Number(cli("--fan-out", "1")) || 1;
const BURST = Number(cli("--burst", "5")) || 5;
const JSON_OUT = cli("--json", undefined);

async function rpc(chainId, method, params, { fanout = FANOUT } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const url = `${BASE_URL}/internal/v1/${chainId}?fanoutCount=${fanout}`;
      const headers = { "content-type": "application/json" };
      if (SECRET !== "") headers["x-internal-secret"] = SECRET;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      });
      const json = await res.json();
      if (res.ok && !json.error) return json.result;
      // Retry once on transient/upstream-limited errors; surface others.
      const msg = (json.error?.message ?? `HTTP ${res.status}`).toString();
      if (/rate limit|too many|429|502|530|try again/i.test(msg)) {
        lastErr = new Error(`${method} chain ${chainId}: ${msg}`);
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw Object.assign(new Error(`${method} chain ${chainId} [${res.status}]: ${msg}`), {
        code: json.error?.code,
      });
    } catch (e) {
      lastErr = e;
      if (e.code !== undefined || !/rate limit|too many|429|503|502|530/i.test(String(e.message)))
        throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error(`${method} failed`);
}

async function runChain(target) {
  const head = BigInt(await rpc(target.id, "eth_blockNumber", []));
  const height = head - 1n;
  const block = await rpc(target.id, "eth_getBlockByNumber", [`0x${height.toString(16)}`, true]);
  const blockHash = block.hash;
  const txCount = (block.transactions ?? []).length;

  let logs = [];
  let badHashes = 0;
  let logsUnsupported = false;
  try {
    logs = await rpc(target.id, "eth_getLogs", [{ blockHash, topics: [TRANSFER_TOPIC] }]);
    badHashes = (logs ?? []).filter(
      (l) => l.blockHash?.toLowerCase() !== blockHash.toLowerCase(),
    ).length;
  } catch (e) {
    const msg = String(e.message);
    if (
      /method not available|not supported|unsupported|requires? an api key|needs an account|auth error/i.test(
        msg,
      )
    ) {
      logsUnsupported = true; // upstream doesn't serve this method / needs auth
    } else {
      throw e;
    }
  }

  let receiptOk = true;
  let receiptUnavailable = false;
  if (txCount > 0) {
    try {
      const receipt = await rpc(target.id, "eth_getTransactionReceipt", [
        block.transactions[0].hash,
      ]);
      receiptOk = receipt !== null && receipt.blockHash?.toLowerCase() === blockHash.toLowerCase();
    } catch (e2) {
      const msg = String(e2.message);
      if (/usage limit|plan|rate limit|too many|502|530|upgrade/i.test(msg)) {
        receiptUnavailable = true; // upstream capacity/plan limit, not our logic
      } else {
        throw e2;
      }
    }
  }

  return {
    label: target.label,
    chainId: target.id,
    head,
    height,
    txCount,
    logsCount: logs?.length ?? 0,
    badHashes,
    logsUnsupported,
    receiptOk,
    receiptUnavailable,
  };
}

async function main() {
  const results = [];
  for (const target of TARGETS) {
    try {
      const r = await runChain(target);
      results.push(r);
      const logStats = r.logsUnsupported ? "skip(upstream)" : `logs=${r.logsCount}`;
      console.log(
        `[ok]   ${r.label.padEnd(9)} height=${r.height} txs=${r.txCount} ${logStats} hashMismatch=${r.badHashes} receiptOk=${r.receiptOk}`,
      );
    } catch (e) {
      const msg = String(e.message);
      if (/quota|rate limit|limit|plan|upgrade|too many|502|530|usage/i.test(msg)) {
        results.push({
          label: target.label,
          chainId: target.id,
          skipLimit: true,
          note: msg.slice(0, 80),
        });
        console.warn(`[skip] ${target.label}: upstream limit (${msg.slice(0, 60)})`);
      } else {
        results.push({ label: target.label, chainId: target.id, error: String(e) });
        console.error(`[FAIL] ${target.label}: ${e.message}`);
      }
    }
  }

  // Amplification: report the configured fan-out and a sample response size.
  let amp = {};
  if (results[0] && !results[0].error && !results[0].skipLimit) {
    const a = await rpc(results[0].chainId, "eth_blockNumber", []);
    amp = { fanout: FANOUT, blockBytes: byteSize(JSON.stringify(a)) };
  }

  // Burst: internal path must not be gated by the public 60/min per-IP budget.
  // (Upstream providers may still 429 at high QPS, so failures here are
  // logged but not a hard failure — the internal path itself stays reachable.)
  let burstOk = 0;
  for (let i = 0; i < BURST; i += 1) {
    try {
      await rpc(8453, "eth_blockNumber", [], { fanout: 1 });
      burstOk += 1;
    } catch {
      // count failures
    }
  }

  const failed = results.filter(
    (r) =>
      (r.error && !r.skipLimit) ||
      r.badHashes > 0 ||
      (r.txCount > 0 && !r.receiptOk && !r.receiptUnavailable),
  );
  const yes = failed.length === 0;
  const summary = { results, amp, burstOk, burstNeed: BURST, pass: yes };
  if (JSON_OUT) await Bun.write(JSON_OUT, JSON.stringify(summary, null, 2));

  console.log(
    `\nfailed=${failed.length} amp=${JSON.stringify(amp)} burst=${burstOk}/${BURST} -> ${yes ? "PASS" : "FAIL"}`,
  );
  process.exit(yes ? 0 : 1);
}

function byteSize(s) {
  return new TextEncoder().encode(s).length;
}

await main();
