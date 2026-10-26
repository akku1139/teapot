import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventBelongsOnTimeline,
  deltaBelongsToTimeline,
} from "../frontend/lib/session-scope.ts";

const EV = (agent: string, session: string) => ({ agent, session });

test("an event from another agent is rejected (#146)", () => {
  assert.equal(eventBelongsOnTimeline(EV("B", "s1"), "A", "s1"), false);
});

test("an event from the SAME agent but another session is REJECTED (#146)", () => {
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
  assert.equal(eventBelongsOnTimeline(EV("A", "s1"), "A", null), true);
});

test("nothing is accepted with no selected agent (#146)", () => {
  assert.equal(eventBelongsOnTimeline(EV("A", "s1"), null, "s1"), false);
});

test("a live delta from another session does not touch the bubble (#40, #146)", () => {
  assert.equal(
    deltaBelongsToTimeline({ agentId: "A", sessionId: "s2" }, "A", "s1"),
    false,
    "the current session's stream must not appear on a historical session (#146)",
  );
});

test("a live delta with NO session id is NOT attributed (#146)", () => {
  assert.equal(
    deltaBelongsToTimeline({ agentId: "A", sessionId: undefined }, "A", "s1"),
    false,
    "an un-attributable delta must not be shown as this session's work (#146)",
  );
});

test("a missing sessionId is rejected even with NO timeline (#146)", () => {
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

