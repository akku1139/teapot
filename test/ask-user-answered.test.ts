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

/* ---------- the rule — the SHIPPED one (#75) ---------- */

/**
 * This file used to carry a verbatim copy of the derivation, exported as
 * `answeredQuestionIds`, and every test called THAT. Deleting either half of the
 * real logic — the optimistic mark, or the log-wins rule — left all nine tests
 * passing, because the copy still had both.
 *
 * The rule now lives in `frontend/question-answered.ts` and App.tsx calls it, so
 * these tests drive the code that runs.
 */
import { answeredQuestionIdsOf as answeredQuestionIds } from "../frontend/question-answered.ts";

type Ev = { id: string; seq: number; type: string; data: Record<string, unknown> };

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
