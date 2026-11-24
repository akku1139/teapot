/**
 * Background job rows arrive over the socket and keep their identity when nothing changed (#290).
 *
 * The panel used to poll `/bg-jobs` every 2 seconds and REPLACE the array, so `<For>` — which keys on item identity — disposed
 * and recreated every card on every tick. The rows now come with the agent snapshot (the same frame that carries the header's
 * "N running" badge, so the two can no longer disagree), and the client merges by id: a job whose fields are unchanged keeps
 * its previous object, so its `<details>`/scroll state survives.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergeBgJobs } from "../frontend/lib/bg-jobs-merge.ts";

const job = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  cmd: `run ${id}`,
  running: true,
  code: null,
  startedAt: 1000,
  tail: "line",
  truncated: false,
  ...over,
});

test("an unchanged snapshot keeps every previous row object", () => {
  const prev = [job("bg1"), job("bg2")];
  const next = mergeBgJobs(prev, [job("bg1"), job("bg2")]);
  assert.equal(next, prev, "the same array — nothing to re-render");
  assert.equal(next[0], prev[0], "row identity is preserved");
});

test("only the row that changed is replaced", () => {
  const prev = [job("bg1"), job("bg2")];
  const next = mergeBgJobs(prev, [job("bg1", { tail: "more output" }), job("bg2")]);
  assert.notEqual(next, prev);
  assert.notEqual(next[0], prev[0], "the changed row is a new object");
  assert.equal(next[1], prev[1], "its neighbour is untouched");
});

test("a job that finished is a new row, and a removed job disappears", () => {
  const prev = [job("bg1"), job("bg2")];
  const next = mergeBgJobs(prev, [job("bg1", { running: false, code: 0 })]);
  assert.equal(next.length, 1);
  assert.equal(next[0]!.running, false);
});
