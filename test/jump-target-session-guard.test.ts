import assert from "node:assert/strict";
import test from "node:test";
import { jumpTargetMatches } from "../frontend/lib/jump-target.ts";

test("a jump may not use a row from the session that was just left (#192)", () => {
  /**
   * Reported on a session switch in v0.37.124: the timeline landed on
   * `<div class="msg withdrawn" data-eid="e90468" data-session="teapot-10-16854917">` — an old row of the session
   * being left, found by id because ids are per-session counters.
   */
  assert.equal(jumpTargetMatches("teapot-10-16854917", "teapot-10-16854917"), true, "the row on screen");
  assert.equal(jumpTargetMatches("teapot-10-16854917", "hono-ja-58f5d7b2"), false, "the row of another session");
  // older logs predate the attribute, so a missing one is trusted rather than skipped silently
  assert.equal(jumpTargetMatches(undefined, "hono-ja-58f5d7b2"), true);
  assert.equal(jumpTargetMatches("", "hono-ja-58f5d7b2"), true);
});
