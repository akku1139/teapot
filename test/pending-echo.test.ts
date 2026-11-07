import test from "node:test";
import assert from "node:assert/strict";
import { mergeQueued } from "../frontend/lib/pending-echo.ts";


test("a prompt whose id the client proposed is never cloned from the server queue", () => {
  /**
   * The client sends its row id as `clientId`, so the server's queue entry carries the SAME id. Before that, the echo
   * had `@p…` and the queue `p…`, and the entry was re-added as a clone — the clone says "queued…" unconditionally, so
   * a prompt sent to an IDLE agent blinked queued for a frame or two.
   */
  const mine = [{ id: "@p123", text: "hello there", at: 1 }];
  const queue = [{ id: "@p123", text: "hello  there ", at: 1 }];
  assert.deepEqual(mergeQueued(mine, queue), mine, "same id, different whitespace: still one row");
});

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
  /**
   * The provisional flag is ONE fact: a turn is running. The server's `ahead` decides for real once the POST returns.
   * Every other input was tried and measured wrong — a lagging snapshot count labelled an idle send "queued…".
   */
  assert.equal(queuedOnSend(true), true, "a running agent means this prompt cannot start immediately");
  assert.equal(queuedOnSend(false), false, "an idle agent starts on it, so it is not queued");
  assert.equal(queuedOnSend(), false, "an unknown status must not invent a queue");
});
