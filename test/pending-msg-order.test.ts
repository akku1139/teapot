/**
 * #37 — "a pending message should sit at the very BOTTOM of the timeline,
 * because it is sent to the LLM after the messages currently on the timeline."
 *
 * The log assigns a prompt its seq at the moment it is TYPED. The agent keeps
 * working meanwhile, so its later turns are logged at HIGHER seqs — and the
 * undelivered prompt rendered above work that came after it, saying the opposite
 * of the order the model will actually see:
 *
 *     e1 -> typed -> a -> b -> c        <- rendered
 *     e1 -> a -> b -> c -> typed        <- what the model receives
 *
 * `resequenceToDelivery` only moved a prompt once its `prompt-delivered` note
 * existed, so until then it stayed at its typing position.
 *
 * An undelivered user prompt now sits at the bottom, just above the echo block —
 * which is the same message — and a DELIVERED one still moves to its precise
 * delivery point, which is unchanged and more accurate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pendingFloor, resequenceToDelivery } from "../frontend/timeline-order.ts";

interface Row {
  id: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
}
const P = (id: string, seq: number, promptId: string): Row => ({
  id,
  seq,
  type: "prompt",
  data: { source: "user", promptId },
});
const M = (id: string, seq: number): Row => ({ id, seq, type: "message", data: {} });

/** the rule as the component applies it */
function order(log: Row[], delivered = new Map<string, number>(), cancelled = new Map<string, number>()) {
  const visible = [...log];
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i]!;
    if (e.type !== "prompt" || e.data.source !== "user") continue;
    const pid = String(e.data.promptId ?? "");
    const settled = Math.max(delivered.get(pid) ?? 0, cancelled.get(pid) ?? 0) || undefined;
    visible[i] =
      settled !== undefined ? resequenceToDelivery(e, settled) : { ...e, seq: pendingFloor(visible) };
  }
  return [...visible].sort((a, b) => a.seq - b.seq).map((r) => r.id);
}

test("an undelivered prompt sits at the BOTTOM (#37)", () => {
  assert.deepEqual(
    order([M("e1", 1), P("typed", 2, "p1"), M("a", 3), M("b", 4), M("c", 9)]),
    ["e1", "a", "b", "c", "typed"],
    "a prompt the model has not received must render last (#37)",
  );
});

test("a DELIVERED prompt moves to where the model consumed it (#37)", () => {
  // unchanged behaviour, and more precise than "bottom"
  assert.deepEqual(
    order([M("e1", 1), P("typed", 2, "p1"), M("a", 3), M("b", 4), M("c", 9)], new Map([["p1", 7]])),
    ["e1", "a", "b", "typed", "c"],
    "delivery re-sequencing still wins once the note exists (#37)",
  );
});

test("a cancelled prompt is still placed at its cancellation (#37)", () => {
  assert.deepEqual(
    order([M("e1", 1), P("gone", 2, "p1"), M("a", 3), M("c", 6)], new Map(), new Map([["p1", 6]])),
    ["e1", "a", "gone", "c"],
    "a withdrawn prompt belongs at the withdrawal, not the bottom (#37)",
  );
});

test("an already-delivered prompt is unaffected (#37)", () => {
  assert.deepEqual(order([P("old", 2, "p1"), M("a", 3), M("c", 9)], new Map([["p1", 9]])), [
    "a",
    "old",
    "c",
  ]);
});

test("pendingFloor is one past the log's maximum (#37)", () => {
  assert.equal(pendingFloor([M("a", 3), M("b", 9)]), 10, "a pending row must clear everything logged (#37)");
  assert.equal(pendingFloor([]), 1, "an empty log still needs a slot (#37)");
});

test("the component uses the floor only when nothing settled (#37)", () => {
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  const at = app.indexOf("const settled = Math.max(delivered, cancelSeq");
  assert.notEqual(at, -1, "the branch must exist (#37)");
  const around = app.slice(at, at + 260);
  assert.match(
    around,
    /settled !== undefined[\s\S]{0,120}?resequenceToDelivery\(e, settled\)[\s\S]{0,120}?pendingFloor\(visible\)/,
    "delivered/cancelled takes precedence; otherwise the floor (#37)",
  );
});
