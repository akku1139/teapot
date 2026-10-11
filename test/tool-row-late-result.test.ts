/**
 * #54 — "while streaming, a bash row sometimes never finishes. Reloading
 * through the API completes it."
 *
 * TWO causes, both MEASURED against the built bundle (happy-dom, the same
 * fixture approach as scripts/smoke-web.mjs), because this issue has been
 * declared fixed three times and reopened each time. Reasoning about it produced
 * a wrong conclusion every time; driving it produced the answer immediately.
 *
 * ## 1. The session gate silently dropped every socket frame
 *
 * `timelineId()` is the AGENT ID until the session index lands (`select()` does
 * `latestSessionOf(id) ?? id`). The #146 event gate compared an event's real
 * `session` against that agent id, so in that window EVERY event mismatched and
 * `mergeEvents` was never reached. Only `runFeedRefresh`'s REST re-read moved the
 * feed — the report, verbatim: the API path completes the row, the socket does
 * not.
 *
 * Measured: the SAME frame rendered when its `session` was the agent id and was
 * dropped when it was the real session id. Both gates checked independently.
 *
 * ## 2. `ToolRow` captured its result prop instead of reading it
 *
 * `<For each={chatEvents()}>` builds the row while `pairInfo().resFor.get(e.id)`
 * is still `undefined`. When the result arrives, pairInfo recomputes and the prop
 * changes — but `const res = props.res` was bound ONCE, so the row kept the
 * pre-result branch (`running…`, `waiting for output…`) until it was rebuilt.
 *
 * Measured, and this is the decisive one: changing ONE accessor to read
 * `props.res` directly flipped the row's class to `embed done`, while the body —
 * still using the captured copy — went on saying "running…". The prop updates;
 * the destructured copy does not.
 *
 * The fix makes `res` a getter and moves the label/hint/body derivation into a
 * memo, so a late result re-renders the row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import { eventBelongsOnTimeline, timelineAcceptsSession } from "../frontend/session-scope.ts";

const app = readSource(new URL("../frontend/App.tsx", import.meta.url).pathname);

/* ---------- 1: the fallback view must accept frames ---------- */

test("the fallback timeline (shown = the agent id) accepts a real session's frame (#54)", () => {
  // the exact shape that broke: index not landed yet, so the displayed handle is
  // the agent id while the event names a session
  assert.equal(
    eventBelongsOnTimeline({ agent: "alpha", session: "alpha-s1" }, "alpha", "alpha"),
    true,
    "the newest tail IS the agent's current session — dropping it is #54",
  );
});

test("a genuinely cross-session frame is still rejected (#146)", () => {
  // the rule that must NOT be lost while fixing the above
  assert.equal(eventBelongsOnTimeline({ agent: "alpha", session: "alpha-s1" }, "alpha", "alpha-s2"), false);
  assert.equal(eventBelongsOnTimeline({ agent: "beta", session: "beta-s1" }, "alpha", "alpha-s1"), false);
  // the displayed session's own frame is accepted
  assert.equal(eventBelongsOnTimeline({ agent: "alpha", session: "alpha-s1" }, "alpha", "alpha-s1"), true);
  // and the agent id is never compared AS a session id
  assert.equal(timelineAcceptsSession("alpha-s1", "alpha", "alpha"), true);
});

test("the handler delegates to the shared predicate rather than comparing inline (#54)", () => {
  const at = app.indexOf('if (msg.kind === "event") {');
  assert.notEqual(at, -1, "the event branch must exist");
  const b = app.slice(at, app.indexOf('if (msg.kind === "llm-delta")', at));
  assert.match(b, /eventBelongsOnTimeline\(/, "the gate must be the shared predicate (#54)");
  assert.doesNotMatch(
    b,
    /session !== timelineId\(\)/,
    "the inline compare is the bug — it cannot know the fallback view (#54)",
  );
});

/* ---------- 2: the row must react to a late result ---------- */

test("ToolRow reads its result prop reactively (#54)", () => {
  const at = app.indexOf("function ToolRow(props:");
  assert.notEqual(at, -1, "ToolRow must exist");
  const body = app.slice(at, app.indexOf("/** The un-rendered source text", at));
  assert.doesNotMatch(
    body,
    /^\s*const res = props\.res;/m,
    "capturing the prop binds it once — the row then never learns its result (#54)",
  );
  assert.match(
    body,
    /const res = \(\) => props\.res;/,
    "the result must be read through the prop on every render (#54)",
  );
});

test("the label/hint/body derivation is a MEMO, so a late result re-renders them (#54)", () => {
  const at = app.indexOf("function ToolRow(props:");
  const body = app.slice(at, app.indexOf("/** The un-rendered source text", at));
  assert.match(body, /const derived = createMemo\(/, "the derivation depends on the result (#54)");
  // the mutable `let` bindings must live INSIDE the memo, not in the component
  // body — otherwise they are computed once and only their first value is shown
  const beforeMemo = body.slice(0, body.indexOf("const derived = createMemo("));
  assert.doesNotMatch(
    beforeMemo,
    /^\s*let (icon|label|hint|body)\b/m,
    "the derived values must be built inside the memo, not captured outside it (#54)",
  );
  // and the rendered output must come from the memo
  for (const use of ["derived().icon", "derived().body"]) {
    assert.ok(body.includes(use), `the row must render ${use} (#54)`);
  }
});
