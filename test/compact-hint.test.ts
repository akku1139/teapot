/**
 * `/compact` has three answers and the client must not collapse them into two (#288).
 *
 * "nothing to compact yet ????「動作中にcompactできない?」" — the server answers `queued: true` when a turn is in flight
 * (the compaction runs at the next turn boundary), and the client read only `ran`, so a request made while the agent was
 * working claimed there was nothing to compact.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compactHint } from "../frontend/lib/compact-answer.ts";

test("queued is not the same answer as nothing-to-do", () => {
  assert.equal(compactHint({ ran: false, queued: true }), "compaction queued — runs at the next turn boundary");
  assert.equal(compactHint({ ran: false, queued: false }), "nothing to compact yet");
  assert.equal(compactHint(null), "nothing to compact yet");
});

test("a completed compaction says so", () => {
  assert.equal(compactHint({ ran: true, queued: false }), "context compacted");
  assert.equal(compactHint({ ran: true }), "context compacted");
});
