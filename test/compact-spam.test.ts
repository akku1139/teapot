/**
 * Pressing "compact" repeatedly must compact ONCE.
 *
 * "compactコマンドを連打するとcompactがキューに溜まってcompactされた後にcompactされ続ける" — `compactNow` enqueued a job per
 * press on a SERIAL queue, so three presses ran three compactions one after another, and each one could find new messages
 * (the compaction appends its own summary exchange).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { readEvents } from "../src/log/events.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

test("concurrent compact requests collapse into one", async () => {
  await useTempDirs(["cspam-", "cspam-sd-"], async ([ws, sd]) => {
    let calls = 0;
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => {
        calls += 1;
        return { message: { role: "assistant", content: `reply ${calls} ${"x".repeat(400)}` } };
      },
      contextTokenBudget: 300,
      autoCompact: false,
      autoContinue: false,
    } as never) as InstanceType<typeof Agent>;
    await a.init();
    try {
      a.enqueuePrompt("go", "user");
      a.start("t");
      await a.settled();
      const before = a.stats.compactions;
      // five presses in the same tick: exactly one compaction may run
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => a.compactNow()));
      assert.equal(results.filter((r) => r.ran).length <= 1, true, `at most one may report "ran": ${JSON.stringify(results)}`);
      assert.equal(a.stats.compactions - before <= 1, true, `one press-burst = one compaction; got ${a.stats.compactions - before}`);
      const events = await readEvents(`${sd}/chat.jsonl`);
      const starts = events.filter((e) => e.type === "system_note" && (e.data as { event?: string })?.event === "context-compaction-started");
      assert.equal(starts.length <= 1, true, `one compaction may be logged; got ${starts.length}`);
    } finally {
      a.stop("test done");
    }
  });
});
