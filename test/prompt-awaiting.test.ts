/**
 * A prompt row says "queued…" only when the server recorded something AHEAD of it.
 *
 * MEASURED, reported three times and fixed twice by inference: an idle or `waiting` agent takes the prompt within
 * milliseconds, so a row that simply had not seen its delivery note yet claimed "queued…" for a frame —
 * "idleやwaitingからプロンプト送ると一瞬キューになってる". The queue position is known when the prompt is enqueued, so it
 * travels with the logged event and the row is drawn from it: a fact, not a guess about timing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { markAwaitingPrompts, promptLifecycle } from "../frontend/lib/timeline.ts";

const ev = (id: string, seq: number, type: string, data: Record<string, unknown>) =>
  ({ id, seq, ts: "2026-01-01T00:00:00Z", session: "s", branch: "br0", parent: null, type, data }) as never;

const NO_NOTES = promptLifecycle([]);

test("a prompt with nothing ahead of it is never drawn as queued", () => {
  const events = [ev("e1", 1, "prompt", { source: "user", text: "go", promptId: "p1", ahead: 0 })];
  const out = markAwaitingPrompts(events, NO_NOTES);
  const row = out[0] as unknown as { data: { pending?: boolean; queued?: boolean } };
  assert.equal(row.data.pending, undefined, "an idle send starts immediately — no pending look, no flash");
  assert.equal(row.data.queued, undefined);
});

test("a prompt behind a turn is drawn as queued, before any delivery note exists", () => {
  const events = [ev("e1", 1, "prompt", { source: "user", text: "go", promptId: "p1", ahead: 1 })];
  const out = markAwaitingPrompts(events, NO_NOTES);
  const row = out[0] as unknown as { data: { pending?: boolean; queued?: boolean } };
  assert.equal(row.data.pending, true, "it cannot start yet");
  assert.equal(row.data.queued, true, "and it says so");
});

test("harness prompts follow the same rule", () => {
  const events = [
    ev("e1", 1, "prompt", { source: "harness", text: "[harness] tasks", promptId: "h1", ahead: 0 }),
    ev("e2", 2, "prompt", { source: "harness", text: "[harness] again", promptId: "h2", ahead: 1 }),
  ];
  const out = markAwaitingPrompts(events, NO_NOTES) as unknown as { data: { pending?: boolean } }[];
  assert.equal(out[0]!.data.pending, undefined, "the first one is what the agent picks up");
  assert.equal(out[1]!.data.pending, true, "the second waits behind it — the reported '一瞬確定する' case");
});

test("a log without `ahead` (an older session) is left alone rather than guessed at", () => {
  const events = [ev("e1", 1, "prompt", { source: "user", text: "go", promptId: "p1" })];
  const row = markAwaitingPrompts(events, NO_NOTES)[0] as unknown as { data: { pending?: boolean } };
  assert.equal(row.data.pending, undefined, "no information is not evidence of waiting");
});

test("marking is cached: the same event yields the same object (row identity)", () => {
  const events = [ev("e1", 1, "prompt", { source: "user", text: "go", promptId: "p1", ahead: 2 })];
  const a = markAwaitingPrompts(events, NO_NOTES)[0];
  const b = markAwaitingPrompts(events, NO_NOTES)[0];
  assert.equal(a, b, "a fresh object per build would re-render every waiting row on every event");
});
