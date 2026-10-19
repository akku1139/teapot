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
import { eventBelongsOnTimeline } from "../frontend/session-scope.ts";

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

