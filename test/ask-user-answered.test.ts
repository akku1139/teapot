import { test } from "node:test";
import assert from "node:assert/strict";

import { answeredQuestionIdsOf as answeredQuestionIds } from "../frontend/lib/question-answered.ts";

type Ev = { id: string; seq: number; type: string; data: Record<string, unknown> };

const ev = (id: string, seq: number, type: string, data: Record<string, unknown> = {}): Ev => ({
  id, seq, type, data,
});

test("without optimistic state a clicked option stays ENABLED (#55)", () => {
  const events = [ev("q1", 1, "question", { callId: "k1", question: "which lib?" })];
  assert.equal(
    answeredQuestionIds(events).has("k1"),
    false,
    "this is the bug: nothing marks it answered until the log catches up (#55)",
  );
});

test("a locally-answered question is answered IMMEDIATELY (#55)", () => {
  const events = [ev("q1", 1, "question", { callId: "k1" })];
  assert.equal(
    answeredQuestionIds(events, new Set(["k1"])).has("k1"),
    true,
    "the click must disable the options without waiting for a round trip (#55)",
  );
});

test("the log still wins once the prompt lands (#55)", () => {
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
  const events = [ev("q1", 1, "question", { callId: "k1" })];
  const got = answeredQuestionIds(events, new Set(["k-from-another-session"]));
  assert.equal(got.has("k1"), false, "a stale id must not disable a real question (#55)");
  assert.equal(got.has("k-from-another-session"), true, "…it is simply an inert entry (#55)");
});
