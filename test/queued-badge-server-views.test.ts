import { test } from "node:test";
import assert from "node:assert/strict";
import { serverQueuedCount } from "../frontend/lib/queued-count.ts";

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
