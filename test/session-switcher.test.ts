import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTimelineSession } from "../frontend/lib/session-index.ts";

const SESSIONS = ["alpha-s2", "alpha-s1"];

test("an explicitly requested session is honoured (#58)", () => {
  assert.equal(
    resolveTimelineSession(SESSIONS, "alpha-s2", "alpha-s1"),
    "alpha-s1",
    "a deep link to alpha-s1 must open alpha-s1 (#58)",
  );
});

test("with no request, the bound session wins (#58)", () => {
  assert.equal(resolveTimelineSession(SESSIONS, "alpha-s2"), "alpha-s2", "the bound session is the default (#58)");
});

test("with neither, the newest session wins (#58)", () => {
  assert.equal(
    resolveTimelineSession(SESSIONS, null),
    "alpha-s2",
    "no bound session → newest (#58)",
  );
  assert.equal(
    resolveTimelineSession(SESSIONS, undefined),
    "alpha-s2",
    "undefined bound behaves the same (#58)",
  );
});

test("a request for a session the agent does NOT own is refused (#58)", () => {
  assert.equal(
    resolveTimelineSession(SESSIONS, "alpha-s2", "beta-s1"),
    "alpha-s2",
    "a crafted URL must not open another agent's timeline (#58)",
  );
});

test("a bound session before the index lands is trusted; truly nothing is null (#58, #146)", () => {
  assert.equal(
    resolveTimelineSession([], "alpha-s2"),
    "alpha-s2",
    "#146: pre-index, the bound session IS the agent's session",
  );
  assert.equal(resolveTimelineSession(undefined, undefined), null, "an unknown agent (#58)");
  assert.equal(resolveTimelineSession([], undefined), null, "no bound and no sessions (#58)");
});

test("a bound session the agent no longer owns is NOT honoured (#58)", () => {
  assert.equal(
    resolveTimelineSession(SESSIONS, "alpha-gone"),
    "alpha-s2",
    "a stale bound session must fall through to the newest (#58)",
  );
});

test("the result is always one the agent owns, or null (#58)", () => {
  for (const bound of [undefined, "alpha-s1", "alpha-s2", "ghost"]) {
    for (const requested of [null, undefined, "alpha-s1", "beta-s1", "ghost"]) {
      const got = resolveTimelineSession(SESSIONS, bound, requested);
      assert.ok(
        got === null || SESSIONS.includes(got),
        `resolveTimelineSession returned an unowned session (${got}) for bound=${bound} requested=${requested}`,
      );
    }
  }
});

test("an explicit request beats a bound session (#58)", () => {
  assert.notEqual(
    resolveTimelineSession(SESSIONS, "alpha-s2", "alpha-s1"),
    "alpha-s2",
    "the whole point of #58: the request is authoritative, not the binding",
  );
});

