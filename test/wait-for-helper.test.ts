import { test } from "node:test";
import assert from "node:assert/strict";
import { waitFor, waitForEvent } from "./helpers/wait-for.ts";

test("waitFor returns as soon as the condition holds, without spending its budget (#wait)", async () => {
  let n = 0;
  const t0 = Date.now();
  await waitFor(() => ++n >= 3, { what: "n to reach 3", timeoutMs: 5_000, intervalMs: 5 });
  const took = Date.now() - t0;
  assert.equal(n, 3, "it stops checking once the condition holds");
  assert.ok(took < 1_000, `must not wait out the budget — took ${took}ms`);
});

test("a timeout names the condition, so a regression reads as what it waited for (#wait)", async () => {
  // the whole point: NOT a bare assertion failure, which is indistinguishable from a real bug
  await assert.rejects(
    () => waitFor(() => false, { what: "the tool result to be logged", timeoutMs: 120, intervalMs: 20 }),
    (e: Error) => {
      assert.match(e.message, /timed out after 120ms/);
      assert.match(e.message, /the tool result to be logged/);
      return true;
    },
  );
});

test("waitForEvent returns the matching entry (#wait)", async () => {
  const log: { type: string; v: number }[] = [];
  setTimeout(() => log.push({ type: "noise", v: 0 }), 10);
  setTimeout(() => log.push({ type: "tool_result", v: 42 }), 40);
  const hit = await waitForEvent(
    () => log,
    (e) => e.type === "tool_result",
    { what: "a tool_result", timeoutMs: 3_000, intervalMs: 10 },
  );
  assert.equal(hit.v, 42, "and it is the entry that matched, not the last one read");
});

test("an async condition is awaited, not treated as truthy (#wait)", async () => {
  // a `() => Promise` is always truthy; without awaiting it this would return immediately
  let ready = false;
  setTimeout(() => (ready = true), 30);
  await waitFor(async () => ready, { what: "ready", timeoutMs: 3_000, intervalMs: 5 });
  assert.equal(ready, true);
});
