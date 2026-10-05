/**
 * #58 / #141 — which session's timeline opens for an agent.
 *
 * ## Why this file was rewritten rather than deleted
 *
 * It previously defined its OWN `resolveSession` and asserted against that copy —
 * three tests covering ZERO shipped code. The mutation that would have proved it
 * is the simplest one there is: delete the logic from `App.tsx` entirely and the
 * file stays green.
 *
 * So the logic is now `resolveTimelineSession()` in `frontend/session-index.ts`:
 * pure in its three inputs, exported, and imported by `App.tsx`. These tests
 * import it, so a change to the real behaviour fails here.
 *
 * ## The rules
 *
 *   1. an EXPLICIT request wins — but only if this agent owns it
 *   2. otherwise the bound session, if the agent still owns it
 *   3. otherwise the newest session it owns
 *   4. no sessions at all → null
 *
 * Rule 1's second half is a security property, not a convenience: a crafted URL
 * must not open another agent's timeline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTimelineSession } from "../frontend/session-index.ts";

// newest first, as /api/agents/:id/sessions returns them
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

test("no sessions at all → null (#58)", () => {
  assert.equal(resolveTimelineSession([], "alpha-s2"), null, "an unbound agent with no sessions (#58)");
  assert.equal(resolveTimelineSession(undefined, undefined), null, "an unknown agent (#58)");
});

/* ---------- the properties that are easy to break ---------- */

test("a bound session the agent no longer owns is NOT honoured (#58)", () => {
  // the bound session can disappear — a log deleted, a config edited. Trusting it
  // would open a timeline that 404s.
  assert.equal(
    resolveTimelineSession(SESSIONS, "alpha-gone"),
    "alpha-s2",
    "a stale bound session must fall through to the newest (#58)",
  );
});

test("the result is always one the agent owns, or null (#58)", () => {
  // the invariant that matters: whatever comes back must be safe to open
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

/* ---------- anti-vacuity: the wiring must still exist ---------- */

test("App.tsx routes its selection through this function (#141)", async () => {
  // the extraction is only worth anything if the app actually calls it
  const { readSource } = await import("./helpers/source.ts");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const app = readSource(path.join(here, "..", "frontend", "App.tsx"));
  assert.match(
    app,
    /from "\.\/session-index"/,
    "App.tsx must import the shared function (#141)",
  );
  assert.match(app, /resolveTimelineSession\(/, "and call it (#141)");
  assert.doesNotMatch(
    app,
    /function resolveTimelineSession\s*\([^)]*\)\s*\{[\s\S]{0,400}?sessionsByAgent\(\)/,
    "the implementation must NOT be duplicated back into the component (#141)",
  );
});