import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimelineWithCount } from "../frontend/lib/timeline.ts";
import { queuedBadgeCount, serverQueuedCount } from "../frontend/lib/queued-count.ts";

/**
 * The ⏳ badge must count the server's queue however the server chooses to express it.
 *
 * The snapshot carries the same fact three ways: `pendingPromptQueue` (with text), `pendingPromptIds`
 * (identity) and `pendingPrompts` (a count — the oldest field). The badge read them as a `??` chain,
 * which falls through only on null/undefined — and the server always sends all three, so an EMPTY
 * ARRAY stopped the chain at 0.
 *
 * MEASURED: `{queue: [], ids: [], pendingPrompts: 3}` produced a badge of **0**, hiding a queue the
 * operator could not otherwise see. The opposite direction is the reported one: a stale echo left the
 * badge showing after the message had been sent.
 */
const take = (server: { queue?: string[]; ids?: string[]; count?: number }): number =>
  serverQueuedCount({ pendingPromptQueue: server.queue, pendingPromptIds: server.ids, pendingPrompts: server.count });

test("an empty queue array does NOT hide a non-zero count (#queue)", () => {
  // the reported shape: the array fields are empty/absent but the count is real
  assert.equal(take({ queue: [], ids: [], count: 3 }), 3, "`?? 0` on an empty array must not win");
  assert.equal(take({ count: 2 }), 2, "a server that only reports the count still counts");
  assert.equal(take({ ids: ["a"], count: 0 }), 1, "and one that only reports ids");
  assert.equal(take({ queue: ["a", "b"] }), 2, "the richest field is the most accurate");
});

test("all-empty is genuinely zero (#queue)", () => {
  assert.equal(take({ queue: [], ids: [], count: 0 }), 0);
});

/**
 * The echo SWEEP: an echo belonging to a session that is not on screen must still be cleared once
 * the log says it was delivered.
 *
 * Leaving a session stops the per-key reconcile from ever running for it. The only other cleaner was
 * the `prompt-delivered` socket note — missed when the socket was reconnecting, the tab was hidden,
 * or in the window between draining the queue and starting the request (server reports
 * `pendingPrompts: 0`, no note written yet). Returning then showed ⏳ for a message already sent.
 */
const echo = (pid: string, text = "hi") => ({ id: `e-${pid}`, promptId: pid, text, at: 1, sent: false });
const input = (events: any[], pending: any[]) => ({
  events,
  consumed: new Set<string>(),
  pending: pending.map((p) => ({ sent: false, ...p })),
  echo: (p: any) => ({ type: "message", id: p.id, seq: 1e9, ts: "", agent: "a", session: "s1", branch: "b", data: { echo: true, content: p.text } }),
  feedTypes: new Set(["prompt", "system_note", "message"]),
  renderedTypes: new Set(["prompt", "message"]),
  renderedNoteEvents: new Set<string>(),
});
const loggedPrompt = (pid: string) => ({ type: "prompt", seq: 1, id: `p-${pid}`, ts: "", agent: "a", session: "s1", branch: "b", data: { source: "user", text: "hi", promptId: pid } });
const note = (pid: string) => ({ type: "system_note", seq: 2, id: `n-${pid}`, ts: "", agent: "a", session: "s1", branch: "b", data: { event: "prompt-delivered", promptId: pid } });

