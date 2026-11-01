import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTimelineSession } from "../frontend/lib/session-index.ts";

/**
 * The URL carries a SESSION id, never an AGENT id.
 *
 * Two separate bugs came from getting this wrong, so the rule now lives at the source instead of at the
 * write site:
 *
 *  - two tabs deep-linked to `/session/tyb2-8` and `/session/teapot-10` both opened the same session, because
 *    `select()` fell back to `?? id` and an agent id resolves to "that agent's latest session". The guard
 *    added then (refuse ids that look like agent ids, using the agent list) needed that list to be current —
 *    and it is not, for an agent created a moment ago.
 *  - so creating a session wrote the AGENT id into the URL ("新しくセッションを作ったときに…URLがエージェント
 *    間メッセージ用の短縮名になる"), and only corrected itself after navigating away and back.
 *
 * `resolveTimelineSession` can only return an id that came from session data, so there is nothing to refuse
 * and nothing to keep fresh.
 */
test("resolution only ever returns a session id — an agent id has no path out", () => {
  const owned = ["tyb2-8-0161a4af"];
  // the agent's own session
  assert.equal(resolveTimelineSession(owned, "tyb2-8-0161a4af"), "tyb2-8-0161a4af");
  // an agent id offered as `requested` is not owned, so it is not returned
  assert.equal(
    resolveTimelineSession(owned, "tyb2-8-0161a4af", "tyb2-8"),
    "tyb2-8-0161a4af",
    "an agent id must never come back out: every tab would resolve it to the same latest session",
  );
  // nothing known at all → NOTHING, which is what stops the URL from being written
  assert.equal(
    resolveTimelineSession(undefined, undefined, "tyb2-8"),
    null,
    "with no session data the answer is null, not the agent id",
  );
  assert.equal(resolveTimelineSession([], undefined), null);
});

test("a session the index has not seen yet still resolves — that is the create path", () => {
  /**
   * A just-created agent has a `session` from the server and no entry in the local index. This is what makes
   * the URL correct immediately after creation, with no refresh to wait for.
   */
  assert.equal(resolveTimelineSession(undefined, "fresh-395d9bef"), "fresh-395d9bef");
  assert.equal(resolveTimelineSession([], "fresh-395d9bef", null), "fresh-395d9bef");
  // but a request for a DIFFERENT session does not override the un-indexed binding
  assert.equal(resolveTimelineSession(undefined, "fresh-395d9bef", "other"), "fresh-395d9bef");
});

test("an explicitly requested session wins when this agent owns it", () => {
  const owned = ["a-1", "a-2"];
  assert.equal(resolveTimelineSession(owned, "a-2", "a-1"), "a-1", "a deep link beats the bound session");
  assert.equal(resolveTimelineSession(owned, "a-2"), "a-2", "without a request the bound session wins");
  assert.equal(resolveTimelineSession(owned, "gone"), "a-1", "an unowned binding falls back to the newest");
});
