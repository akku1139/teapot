import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneDeadLiveBuffers } from "../frontend/lib/live-buffer.ts";

test("the sweep helper itself still drops a stale buffer (#40)", () => {
  const live = new Map([["a", { text: "agent1 was here", reasoning: "", at: 0 }]]);
  const out = pruneDeadLiveBuffers(live, () => "idle");
  assert.equal(out.size, 0, "an idle agent's buffer must be pruned (#40)");
  const kept = pruneDeadLiveBuffers(live, () => "running");
  assert.equal(kept.size, 1, "a running agent's buffer must survive (#40)");
});
