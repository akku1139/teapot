/**
 * #55 — "I clicked the agent's ask_user option but it isn't disabled in the UI."
 *
 * The report's own clue is the diagnosis: switching to another session and back
 * fixes it, so the state is right and merely STALE. That is the same signature
 * as #54 — a value derived purely from the loaded event log.
 *
 * `answeredQuestionIds` marks a question answered only once a user `prompt` (or
 * its `prompt-delivered` note) appears in `events()`. Clicking an option only
 * POSTs the reply and shows a toast; nothing marks the question locally. So
 * between the click and the WS event landing, the options stay enabled — and a
 * second click sends a DUPLICATE prompt, which is the real damage here. Reload
 * or switch away and back re-reads the log, the prompt is present, and the
 * buttons grey out.
 *
 * The fix is optimistic local state: answering disables immediately, and the
 * log remains the source of truth (so a reload, a second tab, or a failed POST
 * all reconcile).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

function srcHas(label: string, re: RegExp): void {
  if (!re.test(app)) assert.fail(`${label}\n  expected source to match: ${re}`);
}

/* ---------- the rule, as a pure function ---------- */

type Ev = { id: string; seq: number; type: string; data: Record<string, unknown> };

/**
 * mirror of the shipped derivation, plus the optimistic override.
 *
 * `locallyAnswered` is the set of callIds the operator has answered in THIS tab
 * but whose prompt event has not arrived yet.
 */
export function answeredQuestionIds(
  events: Ev[],
  locallyAnswered: Set<string> = new Set(),
): Set<string> {
  const set = new Set<string>();
  let lastQuestionAt = -1;
  let lastUserPromptAt = -1;
  for (const e of events) {
    if (e.type === "question") lastQuestionAt = e.seq;
    else if (e.type === "prompt" && e.data?.source === "user") lastUserPromptAt = e.seq;
    else if (e.type === "system_note" && e.data?.event === "prompt-delivered")
      lastUserPromptAt = Math.max(lastUserPromptAt, e.seq);
  }
  if (lastQuestionAt >= 0 && lastUserPromptAt > lastQuestionAt) {
    for (const e of events)
      if (e.type === "question" && e.seq <= lastUserPromptAt) set.add(String(e.data?.callId ?? ""));
  }
  // the click has not reached the log yet — treat it as answered NOW
  for (const id of locallyAnswered) set.add(id);
  return set;
}

const ev = (id: string, seq: number, type: string, data: Record<string, unknown> = {}): Ev => ({
  id, seq, type, data,
});

/* ---------- the bug ---------- */

test("without optimistic state a clicked option stays ENABLED (#55)", () => {
  const events = [ev("q1", 1, "question", { callId: "k1", question: "which lib?" })];
  // the click happened; the prompt event has NOT landed yet
  assert.equal(
    answeredQuestionIds(events).has("k1"),
    false,
    "this is the bug: nothing marks it answered until the log catches up (#55)",
  );
});

/* ---------- the fix ---------- */

test("a locally-answered question is answered IMMEDIATELY (#55)", () => {
  const events = [ev("q1", 1, "question", { callId: "k1" })];
  assert.equal(
    answeredQuestionIds(events, new Set(["k1"])).has("k1"),
    true,
    "the click must disable the options without waiting for a round trip (#55)",
  );
});

test("the log still wins once the prompt lands (#55)", () => {
  // the optimistic set is a shortcut, not a replacement: the derived set must
  // still cover questions answered in a DIFFERENT tab or before a reload
  const events = [
    ev("q1", 1, "question", { callId: "k1" }),
    ev("p1", 2, "prompt", { source: "user", text: "libfoo" }),
  ];
  assert.equal(answeredQuestionIds(events).has("k1"), true, "the log is still authoritative (#55)");
});

test("an unrelated question is not marked answered (#55)", () => {
  const events = [
    ev("q1", 1, "question", { callId: "k1" }),
    ev("q2", 2, "question", { callId: "k2" }),
  ];
  const got = answeredQuestionIds(events, new Set(["k2"]));
  assert.equal(got.has("k2"), true, "the clicked one is answered (#55)");
  assert.equal(got.has("k1"), false, "the OTHER question must stay open (#55)");
});

test("a stale optimistic id for a question that no longer exists is harmless (#55)", () => {
  // switching sessions must not leave a dangling id that disables something.
  // The set may hold it — it is keyed by callId and each row looks up only its
  // OWN id, so an entry with no matching question can never disable anything.
  // What matters is that it does not bleed onto a real question.
  const events = [ev("q1", 1, "question", { callId: "k1" })];
  const got = answeredQuestionIds(events, new Set(["k-from-another-session"]));
  assert.equal(got.has("k1"), false, "a stale id must not disable a real question (#55)");
  assert.equal(got.has("k-from-another-session"), true, "…it is simply an inert entry (#55)");
});

/* ---------- wiring ---------- */

test("the UI keeps a local set of answered questions (#55)", () => {
  srcHas("there must be local answered state (#55)", /locallyAnswered|answeredNow|answeredLocally/);
});

test("clicking an option records the answer locally (#55)", () => {
  // the click handler must mark the question BEFORE/while the POST is in flight,
  // not only fire a request
  srcHas("the click must mark the question answered locally (#55)", /markAnswered|answerLocally/);
});

test("the option button must be disabled once answered (#55)", () => {
  srcHas("the button already binds disabled={answered} (#55)", /disabled=\{answered/);
});

test("the row must read answered REACTIVELY, not from a snapshot (#55)", () => {
  // The subtle half, and the one that actually bit. A <For> child is a
  // non-reactive closure: `answeredIds={answeredQuestionIds()}` was evaluated
  // ONCE when the row was built, so the row kept a pre-click snapshot forever.
  // The old derivation only changed when `events()` changed — which re-created
  // the rows and hid it — but an optimistic answer changes nothing about
  // `events()`, so nothing re-rendered. The prop must be the ACCESSOR.
  srcHas(
    "the accessor must be passed, not the Set it returns (#55)",
    /answeredIds=\{answeredQuestionIds\}/,
  );
  assert.doesNotMatch(
    app,
    /answeredIds=\{answeredQuestionIds\(\)\}/,
    "passing the Set snapshots it inside the <For> closure and the row never updates (#55)",
  );
  // and the row must call it, so the read is tracked
  const block = app.slice(app.indexOf('case "question"'));
  assert.match(
    block.slice(0, 1200),
    /answered\(\)|props\.answeredIds\?\.\(\)/,
    "the row must read answered through the accessor so it is reactive (#55)",
  );
});
