import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The models.dev database is fetched ONCE per TTL, however many callers ask for it.
 *
 * There is one database now, not one endpoint per provider, so the multiplication is different but
 * the failure mode is the same: `fetchModelList` is called for every agent (and on every model
 * change), and an uncached fetch stalls each caller on its own timeout. MEASURED before the negative
 * cache: an unroutable endpoint cost every agent up to 1.5s at boot.
 *
 * `model-meta.ts` holds module-level state, so each test imports a FRESH copy via a cache-busting
 * query — otherwise the first test's cache decides the second's result.
 */
const freshModule = async () => import(`../src/model-meta.ts?t=${Date.now()}${Math.random()}`);

const dbOf = (providers: Record<string, unknown>) => ({ ok: true, status: 200, json: async () => providers });

test("a failing models.dev fetch happens ONCE, not once per caller (#143)", async () => {
  const real = globalThis.fetch;
  const counter = { n: 0 };
  globalThis.fetch = (async () => {
    counter.n++;
    throw new Error("models.dev unreachable");
  }) as unknown as typeof fetch;
  try {
    const { fetchModelList } = await freshModule();
    const url = "https://api.commandcode.ai/provider/v1";
    assert.deepEqual(await fetchModelList(url), [], "an unreachable database reads as 'unknown'");
    assert.deepEqual(await fetchModelList(url), []);
    assert.deepEqual(await fetchModelList(url), []);
    assert.equal(counter.n, 1, `the failure must be remembered, not retried per agent: ${counter.n} fetches`);
  } finally {
    globalThis.fetch = real;
  }
});

test("a successful fetch is shared across callers (#143)", async () => {
  const real = globalThis.fetch;
  const counter = { n: 0 };
  globalThis.fetch = (async () => {
    counter.n++;
    return dbOf({
      commandcode: {
        api: "https://api.commandcode.ai/provider/v1",
        models: { "gpt-5.6-terra": { id: "gpt-5.6-terra", limit: { context: 1_050_000 } } },
      },
    });
  }) as unknown as typeof fetch;
  try {
    const { fetchModelList } = await freshModule();
    const url = "https://api.commandcode.ai/provider/v1";
    const a = await fetchModelList(url);
    const b = await fetchModelList(url);
    assert.equal(counter.n, 1, `a good database must be cached too: ${counter.n} fetches`);
    assert.equal(a.length, 1, "and the provider's models come back");
    assert.equal(a[0]!.contextLength, 1_050_000, "with the fields the UI reads");
    assert.equal(b[0]!.id, "gpt-5.6-terra");
  } finally {
    globalThis.fetch = real;
  }
});

test("an unknown provider is 'no data', not an error and not a retry (#143)", async () => {
  /**
   * A provider missing from models.dev is the normal case for a private endpoint. It must not throw,
   * must not fetch again, and must leave the caller's "unknown" default intact — which is what keeps
   * the reasoning-effort control visible for models we cannot describe.
   */
  const real = globalThis.fetch;
  const counter = { n: 0 };
  globalThis.fetch = (async () => {
    counter.n++;
    return dbOf({ openrouter: { api: "https://openrouter.ai/api/v1", models: {} } });
  }) as unknown as typeof fetch;
  try {
    const { fetchModelList, effortSupportedFor } = await freshModule();
    assert.deepEqual(await fetchModelList("https://private.invalid/v1"), [], "no entry → empty list");
    assert.equal(counter.n, 1, "and the database was still fetched only once");
    assert.equal(effortSupportedFor({ list: [], model: "anything" }), true, "unknown stays ALLOW");
  } finally {
    globalThis.fetch = real;
  }
});
