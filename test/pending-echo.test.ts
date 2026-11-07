import test from "node:test";
import assert from "node:assert/strict";


test("two prompts in flight keep their send order (#211)", async () => {
  /**
   * "メッセージ1 → メッセージ2 の順で送った結果、タイムライン上では上から 2 → 1 の順に並んでる".
   *
   * Both messages were typed before either POST returned, so neither echo had a `promptId` when the server's
   * `pendingPromptQueue` arrived. The old merge treated both as "missing" and PREPENDED them, so the queue's copies
   * landed in front of the echoes — reversing the pair on screen.
   */
  const { mergeQueued } = await import("../frontend/lib/pending-echo.ts");
  const mine = [
    { id: "@p1", text: "first message", at: 1000 },
    { id: "@p2", text: "second message", at: 1010 },
  ];
  const queue = [
    { id: "q1", text: "first message", at: 1001 },
    { id: "q2", text: "second message", at: 1011 },
  ];
  const merged = mergeQueued(mine as never, queue);
  assert.deepEqual(
    merged.map((p) => p.text),
    ["first message", "second message"],
    "the operator's send order is preserved",
  );
  assert.equal(merged.length, 2, "and nothing is duplicated");
});

test("a prompt from ANOTHER client is added at the end, not in front", async () => {
  const { mergeQueued } = await import("../frontend/lib/pending-echo.ts");
  const mine = [{ id: "@p1", text: "mine", at: 1000, promptId: "q1" }];
  const queue = [
    { id: "q1", text: "mine", at: 999 },
    { id: "q9", text: "from another tab", at: 1200 },
  ];
  const merged = mergeQueued(mine as never, queue);
  assert.deepEqual(merged.map((p) => p.text), ["mine", "from another tab"]);
  // and a known promptId is never added twice
  assert.equal(mergeQueued(merged as never, queue).length, 2);
});

test("a prompt is queued only when something is ahead of it (#queued)", async () => {
  /**
   * Decided at send time from "what is already waiting", never from the agent's live status — that status can be one
   * snapshot stale, which made the row appear un-queued and flip a frame later ("非queuedで、queuedより先に挿入 ->
   * queuedになってオーダーが直る").
   */
  const { queuedOnSend } = await import("../frontend/lib/pending-echo.ts");
  assert.equal(queuedOnSend(0, 0), false, "a lone prompt starts the agent — it is not queued");
  assert.equal(queuedOnSend(undefined, 0), false, "and an unknown snapshot must not invent one");
  assert.equal(queuedOnSend(1, 0), true, "the server already has one waiting");
  assert.equal(queuedOnSend(0, 1), true, "another echo is already on screen");
  assert.equal(queuedOnSend(2, 3), true);
});
