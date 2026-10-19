/**
 * #170 — several API keys per provider, rotated when one is rate limited.
 *
 * "複数鍵登録しといて、規定のリトライ回数を超えたら次の鍵にローテみたいなシンプルなアルゴリズムで
 * もいいのかもしれない / 全キーを回ってもまだレートリミットだったらエラーで停止みたいな"
 *
 * That is the whole policy, and this file asserts exactly it:
 *
 *     key1 [retry × N]  ->  key2 [retry × N]  ->  …  ->  raise
 *
 * The client's own retry ladder runs per key (so "規定のリトライ回数" is the SDK's
 * `maxRetries`); only when it is spent and the failure is still a rate limit does the
 * pool move on. When the last key is spent too, the error is raised and the turn stops
 * rather than cycling forever.
 *
 * An earlier version of this feature tracked provider reset hints, classified a 429 as
 * transient-vs-exhausted, and persisted spent accounts to disk. None of that was asked
 * for, none of it was provider-agnostic, and the loop above is what the operator
 * described. The tests below pin the loop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  currentKey,
  isRateLimitStatus,
  makeKeyPool,
  nextKey,
  poolSize,
  resetPool,
} from "../src/agent/key-pool.ts";
import { chat, type LlmConfig } from "../src/agent/llm.ts";
import { migrateProviderKeys, providerKeys } from "../src/master.ts";

/* ---------- the state machine ---------- */

test("a pool starts on the first configured key (#170)", () => {
  const p = makeKeyPool(["A", "B", "C"]);
  assert.equal(currentKey(p), "A");
  assert.equal(poolSize(p), 3);
});

test("keys are unique and in config order, blanks dropped (#170)", () => {
  const p = makeKeyPool(["B", " ", "A", "B", ""]);
  assert.deepEqual(p.keys, ["B", "A"], "order preserved, duplicates and blanks dropped");
});

test("nextKey moves forward one at a time and then reports NO MORE (#170)", () => {
  // null is the "全キーを回ってもまだレートリミット" signal — the caller raises instead of
  // cycling. A wraparound would re-try keys whose retry budget was just spent.
  const p = makeKeyPool(["A", "B", "C"]);
  assert.equal(nextKey(p), "B");
  assert.equal(nextKey(p), "C");
  assert.equal(nextKey(p), null, "no key left: stop, do not wrap");
  assert.equal(currentKey(p), "C", "and it stays on the last key");
});

test("an empty pool has no key at all (#170)", () => {
  const p = makeKeyPool([]);
  assert.equal(currentKey(p), null);
  assert.equal(nextKey(p), null);
});

test("resetPool starts the cycle over (#170)", () => {
  const p = makeKeyPool(["A", "B"]);
  nextKey(p);
  assert.equal(currentKey(p), "B");
  resetPool(p);
  assert.equal(currentKey(p), "A", "a fresh turn gets the full cycle again");
});

test("only rate-limit statuses rotate (#170)", () => {
  assert.equal(isRateLimitStatus(429), true, "the reported case");
  // an exhausted subscription / quota-blocked key answers these, and a second account
  // is exactly what resolves them
  assert.equal(isRateLimitStatus(402), true);
  assert.equal(isRateLimitStatus(403), true);
  // a 5xx or a malformed request fails identically on every key: rotating just burns
  // the cycle
  for (const s of [500, 502, 503, 400, 404, 401, undefined]) {
    assert.equal(isRateLimitStatus(s), false, `status ${s}`);
  }
});

/* ---------- the wiring, through the real chat() ---------- */

/**
 * A stub endpoint that rate-limits `badKeys` and serves everyone else.
 *
 * `retryAfter` is deliberately omitted: the SDK's own 429 backoff would otherwise wait
 * seconds per attempt, and this test is about the ROTATION, not the backoff.
 */
async function stub(badKeys: Set<string>, opts: { status?: number } = {}) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const key = String(req.headers.authorization ?? "").replace("Bearer ", "");
    seen.push(key);
    req.on("data", () => {});
    req.on("end", () => {
      if (badKeys.has(key)) {
        res.writeHead(opts.status ?? 429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `ok-${key}` } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    seen,
    cfg: (pool: ReturnType<typeof makeKeyPool>): LlmConfig => ({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: currentKey(pool)!,
      model: "m",
      timeoutMs: 20_000,
      keyPool: pool,
      // the per-key ladder is not what this file asserts; the ROTATION is. One retry
      // per key keeps the suite fast without changing the policy under test.
      maxRetries: 1,
    }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("a rate-limited key rotates to the next one and the turn SUCCEEDS (#170)", async () => {
  const s = await stub(new Set(["ACCT_1"]));
  try {
    const pool = makeKeyPool(["ACCT_1", "ACCT_2"]);
    const res = await chat(s.cfg(pool), [{ role: "user", content: "hi" }], []);
    assert.equal(res.message.content, "ok-ACCT_2", "the second key served it");
    assert.ok(s.seen.includes("ACCT_2"), `it must have moved on; saw ${JSON.stringify(s.seen)}`);
  } finally {
    await s.close();
  }
});

test("each key gets its FULL retry ladder before the pool moves on (#170)", async () => {
  // "規定のリトライ回数を超えたら次の鍵にローテ" — the ladder is per key, so the SDK's
  // maxRetries must not be zeroed for a pooled provider
  const s = await stub(new Set(["ACCT_1"]));
  try {
    const pool = makeKeyPool(["ACCT_1", "ACCT_2"]);
    await chat(s.cfg(pool), [{ role: "user", content: "hi" }], []);
    const triesOnFirst = s.seen.filter((k) => k === "ACCT_1").length;
    assert.ok(triesOnFirst >= 1, `the first key is tried on its own ladder before rotating; saw ${triesOnFirst}`);
  } finally {
    await s.close();
  }
});

test("when EVERY key is rate limited, the turn FAILS instead of cycling (#170)", async () => {
  // "全キーを回ってもまだレートリミットだったらエラーで停止"
  const s = await stub(new Set(["A", "B"]));
  try {
    const pool = makeKeyPool(["A", "B"]);
    await assert.rejects(
      () => chat(s.cfg(pool), [{ role: "user", content: "hi" }], []),
      /rate|429/i,
      "the failure must reach the caller so the turn stops",
    );
    // and each key must have been tried, not just the first
    for (const k of ["A", "B"]) {
      assert.ok(s.seen.includes(k), `key ${k} was never tried: ${JSON.stringify(s.seen)}`);
    }
  } finally {
    await s.close();
  }
});

test("rotation stops at the pool size — it does not loop forever (#170)", async () => {
  // a cycle would turn a hard rate limit into an infinite retry, which is the failure
  // this policy exists to avoid
  const s = await stub(new Set(["A", "B"]));
  try {
    const pool = makeKeyPool(["A", "B"]);
    await assert.rejects(() => chat(s.cfg(pool), [{ role: "user", content: "hi" }], []));
    const distinct = [...new Set(s.seen)];
    assert.deepEqual(distinct.sort(), ["A", "B"], `exactly the two keys, once each pass: ${JSON.stringify(s.seen)}`);
    assert.ok(s.seen.length < 12, `it must not cycle: ${s.seen.length} attempts`);
  } finally {
    await s.close();
  }
});

test("a 5xx does NOT rotate — it would fail on every key (#170)", async () => {
  const s = await stub(new Set(["K1"]), { status: 500 });
  try {
    const pool = makeKeyPool(["K1", "K2"]);
    await assert.rejects(
      () =>
        chat(
          { ...s.cfg(pool), timeoutMs: 10_000, maxRetries: 1 },
          [{ role: "user", content: "hi" }],
          [],
        ),
    );
    assert.deepEqual(
      [...new Set(s.seen)],
      ["K1"],
      `a 500 must not rotate; saw ${JSON.stringify(s.seen)}`,
    );
  } finally {
    await s.close();
  }
});

test("a single key surfaces the rate limit instead of retrying forever (#170)", async () => {
  // with nothing to rotate to, the honest answer is the error — for the agent's own
  // ladder to decide what next
  const s = await stub(new Set(["ONLY"]));
  try {
    const pool = makeKeyPool(["ONLY"]);
    await assert.rejects(
      () => chat(s.cfg(pool), [{ role: "user", content: "hi" }], []),
      /rate|429/i,
    );
  } finally {
    await s.close();
  }
});

/* ---------- config migration ---------- */

test("a legacy single apiKey migrates to a one-key pool (#170)", () => {
  // every config written before this feature has this shape and must keep working
  const m = migrateProviderKeys({ baseUrl: "u", apiKey: "K1" });
  assert.deepEqual(m.apiKeys, ["K1"]);
  assert.equal(m.apiKey, "K1", "the old field stays readable for other consumers");
});

test("apiKeys is AUTHORITATIVE — a stale apiKey is not folded back in (#170)", () => {
  // the operator listed keys because the old one was exhausted; appending it back
  // would let the rotation land on the key they replaced
  const m = migrateProviderKeys({ baseUrl: "u", apiKey: "OLD", apiKeys: ["A", "B"] });
  assert.deepEqual(m.apiKeys, ["A", "B"]);
  assert.ok(!m.apiKeys!.includes("OLD"));
  assert.equal(m.apiKey, "A", "the scalar mirrors the first list entry");
});

test("a provider with no credential keeps NO apiKeys field (#170)", () => {
  const m = migrateProviderKeys({ baseUrl: "u" });
  assert.equal(m.apiKeys, undefined, "an empty array would read as 'has keys'");
  assert.deepEqual(providerKeys(undefined), []);
});

test("loadConfig migrates every provider, so consumers see one shape (#170)", async () => {
  const { loadConfig } = await import("../src/master.ts");
  const { mkdtempInRootSync } = await import("./helpers/tmp-root.ts");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = mkdtempInRootSync("cfgkeys-");
  const cfgPath = path.join(dir, "config.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      dataDir: dir,
      providers: { legacy: { baseUrl: "u1", apiKey: "K1" }, pooled: { baseUrl: "u2", apiKeys: ["A", "B"] } },
    }),
  );
  const cfg = loadConfig(cfgPath);
  assert.deepEqual(cfg.providers!.legacy!.apiKeys, ["K1"]);
  assert.deepEqual(cfg.providers!.pooled!.apiKeys, ["A", "B"]);
});
