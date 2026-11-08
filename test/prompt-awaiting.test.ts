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

test("the harness row lands in the queue block the moment its event arrives — and the later snapshot changes nothing", () => {
  /**
   * The exact A/B pair GPT's report asked for (teapot#211 follow-up): the same prompt seen (A) as only the WS event and
   * (B) with the agent snapshot that reports it in `pendingPromptQueue`.
   *
   * Before the fix, (A) put the raw row ahead of the existing queued echoes and (B) replaced it with a synthetic echo at
   * the bottom: a row that jumped from the top of the queue to its end. Now the event's own row IS the queue row, so both
   * states must agree — which is what makes the jump impossible rather than merely fast.
   */
  const history = [
    ev("e1", 1, "message", { role: "assistant", content: "older work", final: true }),
    ev("e2", 2, "prompt", { source: "harness", text: "H1", promptId: "h1", ahead: 1 }),
    ev("e3", 3, "prompt", { source: "harness", text: "H2", promptId: "h2", ahead: 2 }),
  ];
  const arrived = [...history, ev("e4", 4, "prompt", { source: "harness", text: "H3", promptId: "h3", ahead: 3 })];
  const stateA = build(arrived).map((r) => r.id);
  // what `mergeQueued` produces from `pendingPromptQueue`: the server ids become `promptId`, flagged queued
  const snapshotQueue = [
    { id: "@p1", text: "H1", at: 1, source: "harness", promptId: "h1", queued: true },
    { id: "@p2", text: "H2", at: 2, source: "harness", promptId: "h2", queued: true },
    { id: "@p3", text: "H3", at: 3, source: "harness", promptId: "h3", queued: true },
  ];
  const stateB = build(arrived, snapshotQueue).map((r) => r.id);
  assert.deepEqual(stateA, ["e1", "e2", "e3", "e4"], "history, then the queue in enqueue order");
  assert.deepEqual(stateB, stateA, "the snapshot must not reorder or duplicate what the event already drew");
});

test("the pending count is the number of rows that SAY queued — an idle send is not a queue", () => {
  /**
   * The badge read "not delivered yet", so an idle send flashed it for the few milliseconds between enqueue and
   * dispatch: "一瞬queuedになってる" with the client's and the server's status both correctly idle.
   */
  const idleSend = [ev("e1", 1, "prompt", { source: "user", text: "go", promptId: "p1", ahead: 0 })];
  assert.equal(
    buildTimelineWithCount({
      events: idleSend as never, consumed: new Set(), pending: [], serverPendingIds: [],
      echo: (p: { id: string; text: string; at: number }) =>
        ({ id: p.id, seq: 1, ts: "2026-01-01T00:00:00Z", session: "s", branch: "br0", parent: null, type: "prompt", data: { text: p.text, pending: true } }) as never,
      feedTypes: FEED, renderedTypes: RENDERED, renderedNoteEvents: new Set(),
    }).pendingCount,
    0,
    "a prompt that starts the agent is not queued",
  );
  const busySend = [ev("e1", 1, "prompt", { source: "user", text: "go", promptId: "p1", ahead: 1 })];
  assert.equal(
    buildTimelineWithCount({
      events: busySend as never, consumed: new Set(), pending: [], serverPendingIds: [],
      echo: (p: { id: string; text: string; at: number }) =>
        ({ id: p.id, seq: 1, ts: "2026-01-01T00:00:00Z", session: "s", branch: "br0", parent: null, type: "prompt", data: { text: p.text, pending: true } }) as never,
      feedTypes: FEED, renderedTypes: RENDERED, renderedNoteEvents: new Set(),
    }).pendingCount,
    1,
    "one that waits is",
  );
});
