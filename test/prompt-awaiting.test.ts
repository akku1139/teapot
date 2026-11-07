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

import { buildTimelineWithCount } from "../frontend/lib/timeline.ts";

const FEED = new Set(["user", "message", "prompt", "tool_call", "tool_result", "progress", "error", "fork", "goal", "todo", "question", "decision", "compaction", "audit_step", "system_note"]);
const RENDERED = new Set(["user", "message", "prompt", "tool_call", "tool_result", "progress", "error", "fork", "goal", "todo", "question", "decision", "compaction", "audit_step"]);
const build = (events: unknown[], pending: unknown[] = []) =>
  buildTimelineWithCount({
    events: events as never,
    consumed: new Set(),
    pending: pending as never,
    serverPendingIds: [],
    echo: (p: { id: string; text: string; at: number }) =>
      ({ id: p.id, seq: 1, ts: "2026-01-01T00:00:00Z", session: "s", branch: "br0", parent: null, type: "prompt", data: { text: p.text } }) as never,
    feedTypes: FEED,
    renderedTypes: RENDERED,
    renderedNoteEvents: new Set(),
  }).rows as unknown as { id: string; type: string }[];

test("waiting prompts sit AFTER delivered history, in the order they were enqueued", () => {
  /**
   * MEASURED: "task追加したときに、一瞬 task4 -> task3 の並びになって、すぐ 3->4 の並びに戻った" — the harness prompt had no
   * optimistic echo, so its log row appeared at its natural seq (above the queue) and the next snapshot swapped it for a
   * queue clone with seq = MAX_SAFE_INTEGER. Two rows, two positions, one visible jump.
   */
  const events = [
    ev("e1", 1, "message", { role: "assistant", content: "history one", final: true }),
    ev("e2", 2, "message", { role: "assistant", content: "history two", final: true }),
    ev("e3", 3, "prompt", { source: "harness", text: "task3", promptId: "h3", ahead: 1 }),
    ev("e4", 4, "prompt", { source: "harness", text: "task4", promptId: "h4", ahead: 2 }),
  ];
  const rows = build(events);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["e1", "e2", "e3", "e4"],
    "history keeps its order and the two waiting prompts follow it, oldest first",
  );
});

test("a delivered prompt keeps its natural place in the log", () => {
  const events = [
    ev("e1", 1, "prompt", { source: "user", text: "go", promptId: "p1", ahead: 0 }),
    ev("e2", 2, "message", { role: "assistant", content: "done", final: true }),
  ];
  assert.deepEqual(build(events).map((r) => r.id), ["e1", "e2"], "nothing is moved for a prompt with nothing ahead");
});

test("one owner per prompt: an echo is not drawn once the log carries that prompt", () => {
  const events = [ev("e1", 1, "prompt", { source: "harness", text: "task3", promptId: "h3", ahead: 1 })];
  const echoRow = { id: "@p1", type: "prompt", seq: 1, ts: "2026-01-01T00:00:00Z", session: "s", branch: "br0", parent: null, data: { source: "harness", text: "task3", pending: true, queued: true, promptId: "h3" } };
  const rows = build(events, [{ id: "@p1", text: "task3", at: 1, promptId: "h3", queued: true }]);
  assert.equal(rows.length, 1, "the log row is the queue row; the echo must not add a second one");
  assert.equal(rows[0]!.id, "e1");
  void echoRow;
});
