/**
 * #40 — "agent2's message is agent1's content, with the writing cursor attached."
 *
 * The history matters because it is why this file is nearly empty.
 *
 * `pruneDeadLiveBuffers()` was correct and fully unit-tested, and the bug still shipped:
 * the WIRING was dead. The effect read `agents()` INSIDE the signal updater —
 *
 *     setLiveByAgent((prev) => {
 *       const statusOf = (id) => agents().find(...)?.status;   // read INSIDE
 *       return pruneDeadLiveBuffers(prev, statusOf);          // the updater
 *     });
 *
 * — and `liveByAgent` is an empty Map on the first run, so the loop body never executed,
 * `statusOf` was never called, and the effect subscribed to NO signal. It ran once, at
 * mount. Measured with an instrumented bundle: "effect runs: 1, statusOf calls: 0".
 *
 * A test here used to assert the SOURCE SHAPE of that effect — that `agents()` appears
 * outside the updater and the closure is named `list`. That is the anti-pattern this repo
 * bans: it pins the spelling of code that has to work at runtime, so it breaks on a
 * refactor that fixes something and stays green through one that breaks it. (The same
 * class of test kept the start/stop toggle green while it posted the wrong action.)
 *
 * The behaviour it was standing for IS covered, and by a check that can fail for the real
 * reason: `scripts/smoke-web.ts` pushes an `llm-delta` to make a live bubble appear,
 * asserts the bubble EXISTS (its own precondition), flips the agent running → idle, and
 * asserts the bubble is gone. If the sweep stops being wired, that check fails.
 *
 * So there is nothing to unit-test here. What remains testable in isolation lives in
 * `live-buffer-reconcile.test.ts` (the pure helper) and `live-buffer.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneDeadLiveBuffers } from "../frontend/live-buffer.ts";

test("the sweep helper itself still drops a stale buffer (#40)", () => {
  // A minimum contract so this file is not empty: the helper the effect calls must do
  // the job it is called for. Whether the effect CALLS it is the smoke test's job.
  const live = new Map([["a", { text: "agent1 was here", reasoning: "", at: 0 }]]);
  const out = pruneDeadLiveBuffers(live, () => "idle");
  assert.equal(out.size, 0, "an idle agent's buffer must be pruned (#40)");
  // and a running one is kept — the other half, so the check above is not vacuous
  const kept = pruneDeadLiveBuffers(live, () => "running");
  assert.equal(kept.size, 1, "a running agent's buffer must survive (#40)");
});
