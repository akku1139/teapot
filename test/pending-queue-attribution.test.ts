import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * #122 — "harness からのメッセージがpendingであるにもかかわらず、メッセージにpending表示がついてない"
 * with the follow-up "pendingカウントがharnessメッセージによって増えてない / そもそもこのバグ直ってなさそう".
 *
 * The queue the server sends (`pendingPromptQueue`) carries `source`, and a harness prompt sits in
 * the SAME queue as the operator's. Two separate consequences, and both were wrong:
 *
 *   1. the ⏳ badge counted every entry but called them all "from you", so the number grew for
 *      messages the operator never wrote — which reads as the count being broken;
 *   2. it also promised "each can be withdrawn with ✕ cancel", which is false for a harness prompt
 *      (there is no ✕ on those).
 *
 * The count is now split by source and the withdrawal sentence only appears when the operator
 * actually has something in the queue.
 */
test("the queue badge attributes each message to its source (#122)", () => {
  const app = readSource("frontend/App.tsx");
  const at = app.indexOf('class="badge queued"');
  assert.ok(at > 0, "the queued badge must exist");
  const body = app.slice(at, at + 2400);
  assert.match(body, /pendingPromptQueue/, "the badge must read the queue, which carries `source` (#122)");
  assert.match(
    body,
    /source \?\? "user"/,
    "and split the count by source — calling a harness prompt a message 'from you' is what made " +
      "the count look wrong (#122)",
  );
  assert.match(body, /from the harness/, "the split must be visible, not silent (#122)");
});
