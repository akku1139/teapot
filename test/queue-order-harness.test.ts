/**
 * A queue is ordered by WHEN, not by who noticed the prompt first (#273).
 *
 * "harnessとyouが同時にキューに入っている(stopでbg bashを止めてプロンプトで再始動など)ときに、メッセージの前後がズレる".
 * `mergeQueued` returned `[...mine, ...added]`: every locally echoed prompt ahead of every prompt the server listed. A
 * harness prompt queued BEFORE the operator's (an auto-nudge, a compaction note) then drew AFTER it, so the queue read
 * backwards — and the rows are the only thing telling the operator what will run in which order.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergeQueued } from "../frontend/lib/pending-echo.ts";

test("a harness prompt queued earlier stays ahead of a later operator prompt", () => {
  const mine = [{ id: "p1", text: "operator prompt", at: 2000 }];
  const queue = [
    { id: "h1", text: "[harness] auto-nudge", at: 1000, source: "harness" },
    { id: "p1", text: "operator prompt", at: 2000 },
  ];
  assert.deepEqual(
    mergeQueued(mine, queue).map((p) => p.text),
    ["[harness] auto-nudge", "operator prompt"],
  );
});

test("an operator prompt queued first stays first", () => {
  const mine = [{ id: "p1", text: "operator prompt", at: 1000 }];
  const queue = [{ id: "h1", text: "[harness] auto-nudge", at: 2000, source: "harness" }];
  assert.deepEqual(
    mergeQueued(mine, queue).map((p) => p.text),
    ["operator prompt", "[harness] auto-nudge"],
  );
});

test("equal timestamps keep the order the rows were created in", () => {
  const mine = [{ id: "p1", text: "first", at: 5000 }];
  const queue = [{ id: "h1", text: "second", at: 5000, source: "harness" }];
  assert.deepEqual(
    mergeQueued(mine, queue).map((p) => p.text),
    ["first", "second"],
  );
});
