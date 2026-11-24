/**
 * A notification about the row on screen is not an unread notification (#282).
 *
 * "スクロール追従時に通知が一瞬表示されるのが邪魔 / スクロール追従中は未読処理挟まずに既読化". Every notification was added
 * unread and cleared by a later scroll or visibility event, so following the stream flashed the badge for a message the
 * operator was watching arrive.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { arrivesRead } from "../frontend/lib/notif-read.ts";

const base = { notifAgentId: "a1", selectedAgentId: "a1", following: true, visible: true };

test("following the tail of the session on screen arrives read", () => {
  assert.equal(arrivesRead(base), true);
});

test("every other case is unread", () => {
  assert.equal(arrivesRead({ ...base, following: false }), false, "the operator scrolled away from the tail");
  assert.equal(arrivesRead({ ...base, selectedAgentId: "a2" }), false, "it is about another session");
  assert.equal(arrivesRead({ ...base, selectedAgentId: undefined }), false, "no session is on screen");
  assert.equal(arrivesRead({ ...base, visible: false }), false, "a hidden tab is not being watched");
});
