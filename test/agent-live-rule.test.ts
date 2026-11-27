/**
 * ONE rule answers "is this agent live?", and the SNAPSHOT's own field wins (#260 followup).
 *
 * `Agent.snapshot()` sends `live: isLive()` — decided where the flags actually live (`parkedByTool`, pending prompts, a queued
 * compaction) — plus `status`, which is already translated by `shownStatus()`. The client re-derived the same boolean from the status
 * STRING in four places, so the panel and the timeline could disagree about one agent at one moment; that is the report this file
 * pins ("フロントエンドとサーバーでステータスの表示が違う").
 *
 * The string list survives only as the fallback for a snapshot that does not carry `live` (an older server, a synthetic fixture). The
 * point of the order is that a field the SERVER computed beats a guess the client makes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { agentIsLive, isLiveStatus } from "../frontend/lib/live-buffer.ts";

test("the server's `live` wins over the status string", () => {
  // the two shapes that a string rule gets wrong on its own
  assert.equal(agentIsLive({ status: "idle", live: true }), true, "an idle agent holding work IS live");
  assert.equal(agentIsLive({ status: "running", live: false }), false, "a server that says not-live is believed over a stale status");
});

test("a snapshot without the field falls back to the status", () => {
  assert.equal(agentIsLive({ status: "running" }), true);
  assert.equal(agentIsLive({ status: "waiting" }), true, "a compaction and a parked tool both read as waiting");
  assert.equal(agentIsLive({ status: "needs_operator" }), true, "a parked question is work in flight");
  assert.equal(agentIsLive({ status: "idle" }), false);
  assert.equal(agentIsLive({ status: "stopped" }), false);
  assert.equal(agentIsLive(undefined), false, "a missing agent is not live");
});

test("the fallback set is the one `shownStatus` can produce, and nothing else", () => {
  // a status that is live in the fallback but never produced by the server would be a second, invisible rule
  for (const s of ["running", "waiting", "needs_operator"]) assert.equal(isLiveStatus(s), true, s);
  for (const s of ["idle", "stopped", "error"]) assert.equal(isLiveStatus(s), false, s);
});
