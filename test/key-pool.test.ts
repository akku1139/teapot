/**
 * #170 — several API keys per provider, rotated automatically.
 *
 * "1プロバイダに複数のAPIキーを紐付けられるようにしてローテーションとかできるように /
 * レートリミットきたAPIキーを自動ローテ".
 *
 * ## The shape this replaces
 *
 * A provider held ONE `apiKey`, so spreading load meant duplicating the provider —
 * the config this was written against had `openrouter`, `openrouter-minimax`,
 * `openrouter-nemotron-3.5-lightning`, `openrouter-glm-5.2` and
 * `openrouter-union-alpha`, five entries differing only in `model` and all sharing
 * one credential. Nothing rotated, so a rate limit stalled every agent at once.
 *
 * The pure rules live in `src/agent/key-pool.ts` and are asserted directly; the
 * rotation is asserted through the REAL `chat()` against a stub endpoint, because a
 * helper-only test would have been green while the wiring was dead (#75).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  KEY_COOLDOWN_MS,
  availableKeys,
  isKeyFailure,
  makeKeyPool,
  nextKey,
  rotateAfterFailure,
} from "../src/agent/key-pool.ts";
import { chat, type LlmConfig } from "../src/agent/llm.ts";
import { migrateProviderKeys, providerKeys } from "../src/master.ts";

/* ---------- the pool rules ---------- */

test("the pool keeps config order, dropping blanks and duplicates (#170)", () => {
  const p = makeKeyPool(["k1", "k2", "k1", "", "  ", "k3"]);
  assert.deepEqual(p.keys, ["k1", "k2", "k3"], "order preserved, no dupes, no blanks");
});

test("keys are handed out ROUND-ROBIN, so consecutive picks differ (#170)", () => {
  // random selection can pick the same key twice while another sits idle, which
  // defeats the entire point of having a pool
  const p = makeKeyPool(["a", "b", "c"]);
  assert.deepEqual([nextKey(p, 0), nextKey(p, 0), nextKey(p, 0), nextKey(p, 0)], ["a", "b", "c", "a"]);
});

test("a rate-limited key is PARKED, not dropped, and returns on its own (#170)", () => {
  const p = makeKeyPool(["a", "b"]);
  const now = 1_000;
  const next = rotateAfterFailure(p, "a", now, 5_000);
  assert.equal(next, "b", "rotation must not hand back the key that just failed");
  assert.deepEqual(availableKeys(p, now), ["b"], "a is parked");
  assert.deepEqual(availableKeys(p, now + 5_000), ["a", "b"], "and comes back when the cooldown lapses");
});

test("a second failure never SHORTENS an existing cooldown (#170)", () => {
  const p = makeKeyPool(["a", "b"]);
  rotateAfterFailure(p, "a", 1_000, 10_000);
  rotateAfterFailure(p, "a", 2_000, 1_000); // an earlier-recovering retry
  assert.equal(p.cooldownUntil.get("a"), 11_000, "the longer cooldown must win");
});

test("with EVERY key cooling down it still hands one out — refusing cannot succeed (#170)", () => {
  const p = makeKeyPool(["a", "b"]);
  const now = 5_000;
  rotateAfterFailure(p, "a", now, 60_000);
  rotateAfterFailure(p, "b", now, 60_000);
  assert.deepEqual(availableKeys(p, now), [], "precondition: nothing is available");
  const got = nextKey(p, now);
  assert.ok(got, "it must return a key rather than null — null turns one 429 into a hard failure");
  assert.ok(["a", "b"].includes(got!), `returned ${got}`);
});

test("a single-key pool does not 'rotate' to the same key (#170)", () => {
  const p = makeKeyPool(["only"]);
  assert.equal(rotateAfterFailure(p, "only", 0), null, "no alternative: the caller's ladder must run");
  assert.equal(nextKey(makeKeyPool([]), 0), null, "an empty pool yields null");
});

test("only KEY-level statuses rotate (#170)", () => {
  assert.equal(isKeyFailure(429), true, "the reported case");
  // a revoked/exhausted key answers these, and with a pool a second key very likely works
  assert.equal(isKeyFailure(401), true);
  assert.equal(isKeyFailure(403), true);
  // a provider outage affects every key equally, and a bad request is bad on all of
  // them — rotating would just burn the pool
  assert.equal(isKeyFailure(500), false);
  assert.equal(isKeyFailure(503), false);
  assert.equal(isKeyFailure(400), false);
  assert.equal(isKeyFailure(undefined), false);
});

/* ---------- the wiring, through the real chat() ---------- */

/** a stub endpoint that answers 429 for `badKey` and 200 for anything else */
async function stub429(badKey: string) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const key = String(req.headers.authorization ?? "").replace("Bearer ", "");
    seen.push(key);
    req.on("data", () => {});
    req.on("end", () => {
      if (key === badKey) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    seen,
    cfg: (pool: ReturnType<typeof makeKeyPool>): LlmConfig => ({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: pool.keys[0]!,
      model: "m",
      timeoutMs: 15_000,
      keyPool: pool,
    }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("a 429 rotates to the next key and the request SUCCEEDS (#170)", async () => {
  const s = await stub429("KEY_A");
  try {
    const pool = makeKeyPool(["KEY_A", "KEY_B"]);
    const res = await chat(s.cfg(pool), [{ role: "user", content: "hi" }], []);
    assert.equal(res.message.content, "ok", "the turn must complete on the second key");
    assert.ok(s.seen.includes("KEY_B"), `it must have tried the second key, saw ${JSON.stringify(s.seen)}`);
    assert.deepEqual(
      availableKeys(pool, Date.now()),
      ["KEY_B"],
      "and the rate-limited key must now be parked for everyone sharing the pool",
    );
  } finally {
    await s.close();
  }
});

test("the SDK does not burn its own retries on the rate-limited key (#170)", async () => {
  // MEASURED before this: the SDK retried the SAME 429 four times (4.5 s of backoff)
  // before rotation ever ran, so having another key bought nothing. It must now be
  // the first thing that happens.
  const s = await stub429("KEY_A");
  try {
    const pool = makeKeyPool(["KEY_A", "KEY_B"]);
    const res = await chat(s.cfg(pool), [{ role: "user", content: "hi" }], []);
    assert.equal(res.message.content, "ok");
    assert.equal(
      s.seen.filter((k) => k === "KEY_A").length,
      1,
      `the dead key must be tried ONCE, not retried; saw ${JSON.stringify(s.seen)}`,
    );
  } finally {
    await s.close();
  }
});

test("with ONE key there is no rotation, and the real error still surfaces (#170)", async () => {
  // The failure must stay honest: a single-key provider cannot rotate, so the 429 has
  // to reach the caller's ladder rather than being swallowed by a no-op retry.
  //
  // The stub returns 429 forever, so the SDK's own 4 retries (kept for this case —
  // see the maxRetries note in llm.ts) legitimately take ~5-9 s of backoff. That is
  // production behaviour for a single key, so it is not shortened here; the
  // assertion is on the OUTCOME, and the timeout leaves room for a slow runner.
  const s = await stub429("ONLY");
  try {
    const pool = makeKeyPool(["ONLY"]);
    await assert.rejects(
      () => chat(s.cfg(pool), [{ role: "user", content: "hi" }], []),
      /429|rate/i,
      "a single key must propagate the rate limit",
    );
    // and it must NOT have been parked: with one key there is nothing to rotate to,
    // and parking it would only make the next attempt slower for no benefit
    assert.deepEqual(availableKeys(pool, Date.now()), ["ONLY"], "no pointless cooldown");
  } finally {
    await s.close();
  }
});

test("a NON-key failure does not rotate (#170)", async () => {
  // a 500 affects every key, so rotating would burn the pool for nothing
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(String(req.headers.authorization ?? "").replace("Bearer ", ""));
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "boom" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const pool = makeKeyPool(["K1", "K2"]);
    await assert.rejects(() =>
      chat(
        { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "K1", model: "m", timeoutMs: 10_000, keyPool: pool },
        [{ role: "user", content: "hi" }],
        [],
      ),
    );
    assert.deepEqual(
      [...new Set(seen)],
      ["K1"],
      `a 500 must not rotate; saw ${JSON.stringify(seen)}`,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("the default cooldown is a minute, not seconds (#170)", () => {
  // long enough to matter for a per-minute rate limit, short enough that an operator
  // who hits one does not have to restart the server
  assert.equal(KEY_COOLDOWN_MS, 60_000);
});

/* ---------- config migration ---------- */

test("a legacy single apiKey migrates to a one-entry pool (#170)", () => {
  // every config written before this feature has exactly this shape, so it must keep
  // working unchanged — no rotation, but no breakage either
  const m = migrateProviderKeys({ baseUrl: "u", apiKey: "K1" });
  assert.deepEqual(m.apiKeys, ["K1"]);
  assert.equal(m.apiKey, "K1", "the old field stays readable for other consumers");
});

test("apiKeys is AUTHORITATIVE — a stale apiKey is not folded back in (#170)", () => {
  // the operator set a LIST because the old key was exhausted. Appending the stale
  // one would let the pool rotate straight back onto the credential they replaced.
  const m = migrateProviderKeys({ baseUrl: "u", apiKey: "OLD", apiKeys: ["A", "B"] });
  assert.deepEqual(m.apiKeys, ["A", "B"], "the list wins");
  assert.equal(m.apiKey, "A", "and the scalar mirrors the FIRST list entry");
  assert.ok(!m.apiKeys!.includes("OLD"), "the replaced key must not come back");
});

test("a provider with no credential keeps NO apiKeys field (#170)", () => {
  // a local endpoint may need none; an empty array would read as "this provider has
  // keys" to anything counting them
  const m = migrateProviderKeys({ baseUrl: "u" });
  assert.equal(m.apiKeys, undefined);
  assert.equal(providerKeys({ baseUrl: "u" }).length, 0);
  assert.deepEqual(providerKeys(undefined), [], "an absent provider has no keys");
});

test("blank entries and duplicates are dropped, order preserved (#170)", () => {
  const m = migrateProviderKeys({ baseUrl: "u", apiKeys: ["B", " ", "A", "B"] });
  assert.deepEqual(m.apiKeys, ["B", "A"], "config order, no dups, no blanks");
  assert.equal(m.apiKey, "B", "the scalar is the first SURVIVING key");
});

test("loadConfig migrates every provider, so consumers see one shape (#170)", async () => {
  // the migration runs at LOAD, which is what lets the pool, the UI and the spawn
  // path all agree without each re-deriving it
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
  assert.deepEqual(cfg.providers!.legacy!.apiKeys, ["K1"], "legacy entry migrated");
  assert.deepEqual(cfg.providers!.pooled!.apiKeys, ["A", "B"], "pooled entry untouched");
});
