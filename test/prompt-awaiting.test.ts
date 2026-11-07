/**
 * A prompt row is "queued" until the server says it was DELIVERED — whoever drew the row.
 *
 * MEASURED reports, both from the same defect (only the client's optimistic echo ever got the pending look):
 *   - "idleから送ると一瞬確定する" — the echo was replaced by the log row a frame before the delivery note;
 *   - "task追加したときにharnessがqueuedになるけど、既にqueuedがあったときに、次のharness送信が一瞬確定する" — a harness
 *     prompt has no local echo at all, so its log row is all the operator sees, and it was drawn as settled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { markAwaitingPrompts, promptLifecycle } from "../frontend/lib/timeline.ts";

const ev = (id: string, seq: number, type: string, data: Record<string, unknown>) =>
  ({ id, seq, ts: "2026-01-01T00:00:00Z", session: "s", branch: "br0", parent: null, type, data }) as never;

test("a prompt with no delivery note after the newest one is still waiting", () => {
  const events = [
    ev("e1", 1, "prompt", { source: "user", text: "run", promptId: "p1" }),
    ev("e2", 2, "system_note", { event: "prompt-delivered", promptId: "p1" }),
    ev("e3", 3, "prompt", { source: "user", text: "later", promptId: "p2" }),
  ];
  const out = markAwaitingPrompts(events, promptLifecycle(events));
  const second = out[2] as unknown as { data: { pending?: boolean; queued?: boolean } };
  assert.equal(second.data.pending, true, "no note for p2 yet, so its row is waiting");
  assert.equal(second.data.queued, true, "and it says so");
  const first = out[0] as unknown as { data: { pending?: boolean } };
  assert.equal(first.data.pending, undefined, "p1 was delivered — its row must not claim to be waiting");
});

test("a cancelled prompt is not drawn as waiting", () => {
  const events = [
    ev("e1", 1, "prompt", { source: "user", text: "run", promptId: "p1" }),
    ev("e2", 2, "system_note", { event: "prompt-cancelled", promptId: "p1" }),
  ];
  const out = markAwaitingPrompts(events, promptLifecycle(events));
  const row = out[0] as unknown as { data: { pending?: boolean } };
  assert.equal(row.data.pending, undefined, "the operator withdrew it; it is not queued either");
});

test("an ancient prompt with no note is left alone — a missing note is not evidence of waiting", () => {
  const events = [
    ev("e1", 1, "prompt", { source: "user", text: "old", promptId: "p1" }),
    ev("e2", 50, "prompt", { source: "user", text: "new", promptId: "p2" }),
    ev("e3", 51, "system_note", { event: "prompt-delivered", promptId: "p2" }),
  ];
  const out = markAwaitingPrompts(events, promptLifecycle(events));
  const old = out[0] as unknown as { data: { pending?: boolean } };
  assert.equal(old.data.pending, undefined, "p1 sits before the newest note: this is history, not a queue");
});

test("harness prompts follow the same rule as the operator's own", () => {
  const events = [
    ev("e1", 1, "prompt", { source: "harness", text: "[harness] tasks", promptId: "h1" }),
    ev("e2", 2, "prompt", { source: "harness", text: "[harness] again", promptId: "h2" }),
  ];
  const out = markAwaitingPrompts(events, promptLifecycle(events));
  for (const row of out as unknown as { data: { pending?: boolean } }[]) {
    assert.equal(row.data.pending, true, "neither harness prompt has been dispatched yet");
  }
});
