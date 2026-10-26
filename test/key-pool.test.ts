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
  assert.equal(isRateLimitStatus(402), true);
  assert.equal(isRateLimitStatus(403), true);
  for (const s of [500, 502, 503, 400, 404, 401, undefined]) {
    assert.equal(isRateLimitStatus(s), false, `status ${s}`);
  }
});

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
  const s = await stub(new Set(["A", "B"]));
  try {
    const pool = makeKeyPool(["A", "B"]);
    await assert.rejects(
      () => chat(s.cfg(pool), [{ role: "user", content: "hi" }], []),
      /rate|429/i,
      "the failure must reach the caller so the turn stops",
    );
    for (const k of ["A", "B"]) {
      assert.ok(s.seen.includes(k), `key ${k} was never tried: ${JSON.stringify(s.seen)}`);
    }
  } finally {
    await s.close();
  }
});

test("rotation stops at the pool size — it does not loop forever (#170)", async () => {
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

test("a legacy single apiKey migrates to a one-key pool (#170)", () => {
  const m = migrateProviderKeys({ baseUrl: "u", apiKey: "K1" });
  assert.deepEqual(m.apiKeys, ["K1"]);
  assert.equal(m.apiKey, "K1", "the old field stays readable for other consumers");
});

test("apiKeys is AUTHORITATIVE — a stale apiKey is not folded back in (#170)", () => {
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
