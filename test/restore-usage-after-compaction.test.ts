/**
 * A restore must not resurrect the pre-compaction token count (#298).
 *
 * "compact後にリストアするとトークン使用量がcompact前のままっぽい". The log records `usage` for each request, and a
 * compaction is written when the NEXT turn begins — after the usage that triggered it. Taking the last `usage` whatever
 * it followed therefore reports the number from before the summarization, and `contextSizeForBudgeting` prefers
 * `lastUsage.input` over its own estimate, so the meter, the notice and the pruning gate all inherit it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { usageAfterLastCompaction } from "../src/agent/restore-usage.ts";

const usage = (input: number) => ({ type: "usage", data: { inputTokens: input, outputTokens: 10 } });
const compaction = { type: "compaction", data: { tokensAfter: 24_000 } };

test("the usage BEFORE the compaction is not evidence about the context after it", () => {
  const events = [usage(900_000), compaction];
  assert.equal(usageAfterLastCompaction(events), null, "nothing describes the compacted context yet");
});

test("a usage written after the compaction wins", () => {
  const events = [usage(900_000), compaction, usage(30_000)];
  assert.deepEqual(usageAfterLastCompaction(events), { input: 30_000, output: 10 });
});

test("the newest compaction is the boundary, not the first one", () => {
  const events = [usage(900_000), compaction, usage(30_000), compaction, usage(12_000)];
  assert.equal(usageAfterLastCompaction(events)?.input, 12_000);

  const restoredOnlyOld = [usage(900_000), compaction, usage(30_000), compaction];
  assert.equal(usageAfterLastCompaction(restoredOnlyOld), null, "the 30k usage is from the summarized context");
});

test("no compaction at all keeps the plain last-usage behaviour", () => {
  assert.equal(usageAfterLastCompaction([usage(100), usage(200)])?.input, 200);
  assert.equal(usageAfterLastCompaction([]), null);
});
