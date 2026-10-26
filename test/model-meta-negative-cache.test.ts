/**
 * A FAILED `/models` lookup was never remembered, so every agent pointed at a
 * dead or unauthorised endpoint paid the request again — and `addAgent` awaits
 * this TWICE per agent, racing it against a 1.5s timeout.
 *
 * That is the "boot gets slower as agents accumulate" shape: the cost scaled with
 * the number of agents on the bad endpoint, not with the number of endpoints.
 *
 * Failures are now cached briefly (30s, versus the 10min for a good list), so a
 * provider coming back up is usable within a minute rather than locked out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchModelList } from "../src/model-meta.ts";

/** a fetch that always fails, counting how often it was called */
function failingFetch(counter: { n: number }): typeof fetch {
  return (async () => {
    counter.n++;
    throw new Error("endpoint down");
  }) as unknown as typeof fetch;
}

test("a failing endpoint is fetched ONCE, not once per caller (#143)", async () => {
  const real = globalThis.fetch;
  const counter = { n: 0 };
  globalThis.fetch = failingFetch(counter);
  try {
    // a distinct host so this does not collide with any cached entry
    const url = "http://model-meta-negcache-test.invalid/v1";
    const a = await fetchModelList(url);
    const b = await fetchModelList(url);
    const c = await fetchModelList(url);
    assert.deepEqual(a, [], "an unreachable provider reads as 'unknown'");
    assert.deepEqual(b, []);
    assert.deepEqual(c, []);
    assert.equal(counter.n, 1, `the failure must be remembered, not retried per agent: ${counter.n} fetches`);
  } finally {
    globalThis.fetch = real;
  }
});

test("a SUCCESSFUL lookup is still shared across callers (#143)", async () => {
  const real = globalThis.fetch;
  const counter = { n: 0 };
  globalThis.fetch = (async () => {
    counter.n++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "m1", context_length: 1000 }] }),
    };
  }) as unknown as typeof fetch;
  try {
    const url = "http://model-meta-poscache-test.invalid/v1";
    await fetchModelList(url);
    await fetchModelList(url);
    assert.equal(counter.n, 1, `a good list must be cached too: ${counter.n} fetches`);
  } finally {
    globalThis.fetch = real;
  }
});
