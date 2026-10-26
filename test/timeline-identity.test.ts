/**
 * Does `buildTimeline()` return the SAME row objects when only one event is appended?
 *
 * ## Why this is the root-cause test
 *
 * Reported: "apply_patch のカードを展開していたのに、新しいメッセージが来ると展開していた
 * のが閉じられる". An open `<details>` closing by itself means its row was disposed and
 * re-created, because the browser throws away that state with the node.
 *
 * `<For>` keys on ITEM IDENTITY — it compares `items[i] === nextItems[i]`. So the question
 * "did a row remount?" reduces entirely to "did this pipeline hand back a different object
 * for the same row?" That is answerable here, with no DOM and no component, which is why
 * this test exists: a DOM-shaped assertion cannot see a remount at all (it renders identical
 * HTML), and a smoke test can only say "4 of 18 rows", not WHY.
 *
 * A first attempt at this problem added a cache in `App.tsx` keyed by row object. That hid
 * the symptom for some rows while leaving the cause in place — the pipeline was still handing
 * back fresh objects for every row it derived, so the cache simply missed on those. This file
 * pins the invariant at the source instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline, type TimelineEvent } from "../frontend/lib/timeline.ts";

const FEED = new Set(["prompt", "message", "tool_call", "tool_result", "system_note", "decision", "progress"]);
const RENDERED = new Set(["prompt", "message", "tool_call", "tool_result", "decision", "progress"]);
const NOTES = new Set(["context-compacted"]);

let seq = 0;
const ev = (type: string, data: Record<string, unknown>): TimelineEvent =>
  ({ id: `e${++seq}`, seq, ts: "2026-01-01T00:00:00Z", type, data }) as TimelineEvent;

/** run the pipeline the way the component does */
function run(events: TimelineEvent[], pending: unknown[] = []): TimelineEvent[] {
  return buildTimeline({
    events,
    consumed: new Set<string>(),
    pending: pending as never[],
    echo: (p) => p as unknown as TimelineEvent,
    feedTypes: FEED,
    renderedTypes: RENDERED,
    renderedNoteEvents: NOTES,
  }) as TimelineEvent[];
}

/** the identity of each row, by id, so a rebuild can be compared */
const byId = (rows: TimelineEvent[]) => new Map(rows.map((r) => [r.id, r]));

test("appending one event keeps every existing row's OBJECT IDENTITY", () => {
  const base = [
    ev("prompt", { source: "user", text: "hello", promptId: "p1" }),
    ev("message", { role: "assistant", content: "hi" }),
    ev("tool_call", { name: "bash", args: { command: "ls" } }),
    ev("tool_result", { name: "bash", ok: true, result: "a" }),
  ];
  const first = run(base);
  const firstIds = first.map((r) => r.id);
  assert.ok(first.length >= 3, `precondition: the pipeline rendered ${first.length} rows`);

  const appended = [...base, ev("message", { role: "assistant", content: "later" })];
  const second = run(appended);
  const before = byId(first);

  const changed: string[] = [];
  for (const row of second) {
    const prev = before.get(row.id);
    if (!prev) continue; // the new row, expected
    if (prev !== row) changed.push(row.id);
  }
  assert.deepEqual(
    changed,
    [],
    `an append replaced ${changed.length} row object(s): ${changed.join(", ")}. ` +
      `\`<For>\` keys on identity, so each one is disposed and re-created — which drops DOM ` +
      `state (an open <details> slams shut) and flickers the whole timeline.`,
  );
  void firstIds;
});

test("a PROMPT row keeps its identity across an append (the resequencing path)", () => {
  // `resequencePrompts` rewrites a pending user prompt's `seq` to place it below settled
  // rows, and marks a cancelled one. Both used object spreads, which allocate a NEW object
  // on every rebuild — so every user prompt remounted on every incoming event.
  const base = [ev("prompt", { source: "user", text: "q", promptId: "p9" })];
  const first = run(base);
  assert.equal(first.length, 1, "precondition: one prompt row");
  const appended = [...base, ev("message", { role: "assistant", content: "a" })];
  const second = run(appended);
  const promptRow = second.find((r) => r.type === "prompt" && r.data?.source === "user");
  assert.ok(promptRow, "precondition: the prompt row is still present");
  assert.equal(
    promptRow,
    first[0],
    "the prompt row was re-created by resequencing — every user prompt remounts on every append",
  );
});

test("a CANCELLED prompt keeps its identity across an append (the marker path)", () => {
  const base = [ev("prompt", { source: "user", text: "q", promptId: "p7" })];
  // mark it cancelled the way the log does: a prompt-cancelled system note
  base.push(ev("system_note", { event: "prompt-cancelled", promptId: "p7" }));
  const first = run(base);
  const cancelled = first.find((r) => r.type === "prompt" && r.data?.source === "user");
  assert.ok(cancelled, "precondition: the cancelled prompt row exists");
  assert.equal(cancelled.data?.cancelled, true, "precondition: it carries the withdrawn marker");

  const appended = [...base, ev("message", { role: "assistant", content: "a" })];
  const second = run(appended);
  const again = second.find((r) => r.type === "prompt" && r.data?.source === "user");
  assert.equal(
    again,
    cancelled,
    "the cancelled marker allocated a fresh object, so a withdrawn prompt remounts on every append",
  );
});

test("tool rows keep identity across an append", () => {
  const base = [
    ev("tool_call", { name: "bash", args: { command: "x" } }),
    ev("tool_result", { name: "bash", ok: true, result: "y" }),
  ];
  const first = run(base);
  const appended = [...base, ev("message", { role: "assistant", content: "z" })];
  const second = run(appended);
  const before = byId(first);
  const changed = second.filter((r) => before.has(r.id) && before.get(r.id) !== r).map((r) => r.id);
  assert.deepEqual(changed, [], `tool rows re-created on append: ${changed.join(", ")}`);
});
