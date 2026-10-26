import { test } from "node:test";
import assert from "node:assert/strict";
import { eventBelongsOnTimeline } from "../frontend/lib/session-scope.ts";

test("the fallback timeline (shown = the agent id) accepts a real session's frame (#54)", () => {
  assert.equal(
    eventBelongsOnTimeline({ agent: "alpha", session: "alpha-s1" }, "alpha", "alpha"),
    true,
    "the newest tail IS the agent's current session — dropping it is #54",
  );
  assert.equal(eventBelongsOnTimeline({ agent: "alpha", session: "alpha-s1" }, "alpha", "alpha-s2"), false);
  assert.equal(eventBelongsOnTimeline({ agent: "beta", session: "beta-s1" }, "alpha", "alpha-s1"), false);
  assert.equal(eventBelongsOnTimeline({ agent: "alpha", session: "alpha-s1" }, "alpha", "alpha-s1"), true);
});

