/**
 * #146 — a socket event from one session is merged into another session's timeline.
 *
 * ## The defect
 *
 * The timeline is per SESSION: `loadEvents` fetches with `?session=<timelineId>`,
 * and `select()` sets both `selected()` (agent) and `timelineId()` (session), so a
 * PAST session of the same agent can be displayed.
 *
 * But the WS filter compares only the AGENT:
 *
 *     if (msg.event?.agent !== selected()) return;
 *
 * and `msg.event` carries `session`. So with
 *
 *     displaying  agent A, historical session S1
 *     running      agent A, current session  S2
 *
 * an S2 event arriving over the socket is `mergeEvents()`-ed straight into the S1
 * timeline. No agent check can prevent it: both events belong to the same agent.
 *
 * Two consequences, both reported:
 *
 *  - **#145/#54** a tool row in S1 never closes, because S2's events confuse the
 *    feed re-derivation and `agentActive` tracks the agent, not the session.
 *  - **#40** the live bubble shows the CURRENT session's stream while a HISTORICAL
 *    session is displayed — the report's "agent2's message, but agent1's content,
 *    with a writing cursor".
 *
 * `llm-delta` is worse: it carries only `agentId`, so the client cannot even
 * tell which session's stream it is.
 *
 * These tests exercise the real predicates, not the source text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// #146: these were DEFINED IN THIS FILE, which is #75 again — a test-local copy of
// the rule passes while production is broken. They now live in
// frontend/session-scope.ts and the handler imports the same module.
import {
  eventBelongsOnTimeline,
  deltaBelongsToTimeline,
  rowIsStillActive,
} from "../frontend/session-scope.ts";

const EV = (agent: string, session: string) => ({ agent, session });

test("an event from another agent is rejected (#146)", () => {
  assert.equal(eventBelongsOnTimeline(EV("B", "s1"), "A", "s1"), false);
});

test("an event from the SAME agent but another session is REJECTED (#146)", () => {
  // THE regression. Both events belong to agent A; only the session differs.
  assert.equal(
    eventBelongsOnTimeline(EV("A", "s2"), "A", "s1"),
    false,
    "S2 must not be merged into the S1 timeline (#146)",
  );
});

test("an event from the displayed session is accepted (#146)", () => {
  assert.equal(eventBelongsOnTimeline(EV("A", "s1"), "A", "s1"), true);
});

test("with NO timeline session the agent check alone decides (#146)", () => {
  // `timelineId()` is only empty before a session is resolved. Falling back to
  // agent-only there is correct — refusing everything would blank a brand-new
  // timeline — and safe, because there is no OTHER session to confuse it with.
  assert.equal(eventBelongsOnTimeline(EV("A", "s1"), "A", null), true);
});

test("nothing is accepted with no selected agent (#146)", () => {
  assert.equal(eventBelongsOnTimeline(EV("A", "s1"), null, "s1"), false);
});

/* ---------- the live bubble ---------- */

test("a live delta from another session does not touch the bubble (#40, #146)", () => {
  assert.equal(
    deltaBelongsToTimeline({ agentId: "A", sessionId: "s2" }, "A", "s1"),
    false,
    "the current session's stream must not appear on a historical session (#146)",
  );
});

test("a live delta with NO session id is NOT attributed (#146)", () => {
  // this is why #146 needs a protocol change: the client cannot tell today
  assert.equal(
    deltaBelongsToTimeline({ agentId: "A", sessionId: undefined }, "A", "s1"),
    false,
    "an un-attributable delta must not be shown as this session's work (#146)",
  );
});

test("a missing sessionId is rejected even with NO timeline (#146)", () => {
  // #141: removing the `if (!d.sessionId) return false;` guard alone did NOT fail
  // the suite, because with a timeline present the later `d.sessionId ===
  // timelineSession` catches `undefined` anyway. So that line looked redundant.
  //
  // It is not: with `timelineSession` null it is the ONLY thing standing between
  // an unattributable stream and a bubble. This case isolates it.
  assert.equal(
    deltaBelongsToTimeline({ agentId: "A", sessionId: undefined }, "A", null),
    false,
    "an unattributable delta must never be shown (#146)",
  );
  assert.equal(
    deltaBelongsToTimeline({ agentId: "A", sessionId: "" }, "A", null),
    false,
    "an empty sessionId is no better (#146)",
  );
});

test("a live delta from the displayed session is shown (#146)", () => {
  assert.equal(deltaBelongsToTimeline({ agentId: "A", sessionId: "s1" }, "A", "s1"), true);
});

/* ---------- ToolRow activity must be session-aware ---------- */

test("a tool row's activity must be scoped to the DISPLAYED session (#120, #133)", () => {
  // S1 displayed, S1 has an unpaired tool_call, S2 is running
  assert.equal(
    rowIsStillActive({ data: {} }, /*agentLive*/ true, /*displayedIsLive*/ false),
    false,
    "another session running must NOT make a historical row look live (#120/#146)",
  );
  assert.equal(rowIsStillActive({ data: {} }, true, true), true, "the current session running (#120)");
  assert.equal(rowIsStillActive({ data: {} }, false, true), false);
  // a child's row is never the selected agent's own work
  assert.equal(rowIsStillActive({ data: { actor: "kid" } }, true, true), false, "provenance (#40)");
});
