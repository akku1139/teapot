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
  assert.equal(queuedOnSend(0, 0), false, "a lone prompt starts the agent — it is not queued");
  assert.equal(queuedOnSend(undefined, 0), false, "and an unknown snapshot must not invent one");
  /**
   * The server's count is NOT evidence of waiting: it comes from the last snapshot the client holds and it lags. An idle
   * agent with a stale non-zero count labelled the very first prompt "queued…" for a frame — "idle状態でプロンプトを
   * 送っても一瞬queuedになる問題". What makes a prompt wait is a running turn or another prompt just queued here.
   */
  assert.equal(queuedOnSend(1, 0, false), false, "a stale server count alone does not make it queued");
  assert.equal(queuedOnSend(1, 0, true), true, "a running turn does");
  assert.equal(queuedOnSend(0, 1, false), true, "so does a prompt already queued by this client");
  assert.equal(queuedOnSend(0, 1), true, "another echo is already on screen");
  assert.equal(queuedOnSend(2, 3), true);
});

test("a prompt sent to a BUSY agent is queued even as the first in the queue (#queued)", async () => {
  /**
   * "キューの1つ目のメッセージは時刻がついてるし" — it waited for the running turn, so it is queued; it just had nothing
   * else ahead of it. The value is frozen at send time, so no later status change can relabel the row.
   */
  const { queuedOnSend } = await import("../frontend/lib/pending-echo.ts");
  assert.equal(queuedOnSend(0, 0, true), true, "a running agent means this prompt waits");
  assert.equal(queuedOnSend(0, 0, false), false, "an idle agent starts on it, so it is not queued");
  assert.equal(queuedOnSend(2, 0, false), false, "a lagging server count is not waiting — see above");
  assert.equal(queuedOnSend(0, 1, false), true);
});
