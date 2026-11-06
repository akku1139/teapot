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
