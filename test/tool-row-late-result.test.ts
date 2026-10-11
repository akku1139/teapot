/**
 * #54 — "while streaming, a bash row sometimes never finishes. Reloading through
 * the API completes it." Declared fixed three times, reopened each time, because
 * every previous attempt reasoned about the code instead of driving it. These
 * assertions come from MEASURING the built bundle in happy-dom (the fixture
 * approach of scripts/smoke-web.mjs).
 *
 * TWO causes, both silent:
 *
 * 1. The #146 session gate dropped EVERY socket frame.
 *
 *    `timelineId()` is the AGENT ID until the session index lands (`select()`
 *    does `latestSessionOf(id) ?? id`). The gate compared an event's real
 *    `session` against that agent id, so every frame mismatched, `mergeEvents`
 *    was never reached, and only the REST re-read moved the feed — exactly the
 *    reported asymmetry. Measured A/B: the same frame rendered when its session
 *    was the agent id and vanished when it was the real session id.
 *
 * 2. `ToolRow` captured its props instead of reading them.
 *
 *    `<For each={chatEvents()}>` builds a row while its `res` is still
 *    undefined, and `const res = props.res` was bound once — so a row never
 *    learned its result and kept saying "running…". The stale-run guard was
 *    disabled the same way: `staleDone` captured `agentActive` as it was when the
 *    row was built, which is always `true` for a row that exists, so the guard
 *    written to close this bug could never fire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import { eventBelongsOnTimeline } from "../frontend/session-scope.ts";

const app = readSource(new URL("../frontend/App.tsx", import.meta.url).pathname);

/* ---------- 1: the fallback timeline must accept frames ---------- */

test("the fallback timeline (shown = the agent id) accepts a real session's frame (#54)", () => {
  // the exact shape that broke: index not landed, so the displayed handle is the
  // agent id while the event names a session
  assert.equal(
    eventBelongsOnTimeline({ agent: "alpha", session: "alpha-s1" }, "alpha", "alpha"),
    true,
    "the newest tail IS the agent's current session — dropping it is #54",
  );
  // and the rule that must NOT be lost while fixing it (#146)
  assert.equal(eventBelongsOnTimeline({ agent: "alpha", session: "alpha-s1" }, "alpha", "alpha-s2"), false);
  assert.equal(eventBelongsOnTimeline({ agent: "beta", session: "beta-s1" }, "alpha", "alpha-s1"), false);
  assert.equal(eventBelongsOnTimeline({ agent: "alpha", session: "alpha-s1" }, "alpha", "alpha-s1"), true);
});

test("the event gate delegates to the shared predicate, never an inline compare (#54)", () => {
  const at = app.indexOf('if (msg.kind === "event") {');
  assert.notEqual(at, -1, "the event branch must exist");
  const b = app.slice(at, app.indexOf('if (msg.kind === "llm-delta")', at));
  assert.match(b, /eventBelongsOnTimeline\(/, "the gate must be the shared predicate (#54)");
  assert.doesNotMatch(
    b,
    /session !== timelineId\(\)/,
    "the inline compare cannot know the fallback view — that was the bug (#54)",
  );
  // the three gates that share the decision must all still consult it, or one
  // can drift again exactly as it did before
  for (const use of ["timelineIsLive(", "deltaBelongsToTimeline(", "eventBelongsOnTimeline("]) {
    assert.ok(app.includes(use), `${use} must stay wired (#54)`);
  }
});

/* ---------- 2: the row must react to a late result ---------- */

test("ToolRow reads its result prop reactively, and its derivation is a memo (#54)", () => {
  const at = app.indexOf("function ToolRow(props:");
  assert.notEqual(at, -1, "ToolRow must exist");
  const body = app.slice(at, app.indexOf("/** The un-rendered source text", at));
  assert.doesNotMatch(
    body,
    /^\s*const res = props\.res;/m,
    "capturing the prop binds it once — the row then never learns its result (#54)",
  );
  assert.match(body, /const res = \(\) => props\.res;/, "the result must be read per render (#54)");
  // the mutable bindings must live INSIDE the memo; computed outside it they are
  // built once and only their first value is ever shown
  const memoAt = body.indexOf("const derived = createMemo(");
  assert.notEqual(memoAt, -1, "the derivation depends on the result, so it must be a memo (#54)");
  assert.doesNotMatch(
    body.slice(0, memoAt),
    /^\s*let (icon|label|hint|body)\b/m,
    "the derived values must be built inside the memo (#54)",
  );
  for (const use of ["derived().icon", "derived().body"]) {
    assert.ok(body.includes(use), `the row must render ${use} (#54)`);
  }
});

test("the stale-run guard re-reads its props, so it can actually fire (#54)", () => {
  // as a captured value it was permanently false — this is the guard that was
  // meant to close #54
  assert.match(
    app,
    /const staleDone = \(\) => !props\.agentActive && !res\(\);/,
    "the guard must be a function over the current props (#40/#54)",
  );
  const tag = app.slice(app.indexOf("function ToolRow(props:"), app.indexOf("/** The un-rendered source text", app.indexOf("function ToolRow(props:")));
  assert.match(tag, /staleDone\(\) ?\?/, "and its call sites must invoke it (#54)");
});
