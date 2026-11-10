/**
 * The re-context notes must be logged AFTER the compaction event.
 *
 * MEASURED in mediapad-t5-root-attempt-2-2601e254's chat.jsonl: `prompt … [harness] Your durable notes … re-attached` sat
 * at seq 42773/42774 and the `compaction` event at 42775 — i.e. the notes were written FIRST, so the timeline showed them
 * ABOVE the "context compacted" row ("これ何故かタイムライン的にはcompactより前に表示されてるよ"). The conversation itself had
 * the checkpoint first, so the log and the conversation disagreed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { readEvents } from "../src/log/events.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

test("the compaction event precedes the notes it triggered", async () => {
  await useTempDirs(["co-", "co-sd-"], async ([ws, sd]) => {
    let n = 0;
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => {
        n += 1;
        return { message: { role: "assistant", content: `reply ${n} ${"r".repeat(700)}` } };
      },
      contextTokenBudget: 1_500,
      autoContinue: false,
    } as never) as InstanceType<typeof Agent>;
    await a.init();
    try {
      await a.setGoal("ship the queue fix");
      for (let i = 0; i < 8; i++) {
        a.enqueuePrompt(`go ${i}`, "user");
        a.start("t");
        await a.settled();
      }
      await a.compactNow();
      const events = await readEvents(`${sd}/chat.jsonl`);
      const compactionAt = events.findIndex((e) => e.type === "compaction");
      const noteAt = events.findIndex(
        (e) => e.type === "prompt" && String((e.data as { text?: string })?.text ?? "").includes("re-attached after compaction"),
      );
      assert.ok(compactionAt !== -1, "a compaction must have happened for this check to mean anything");
      assert.ok(noteAt !== -1, "and it must have re-attached context");
      assert.ok(
        compactionAt < noteAt,
        `the notes must follow the compaction in the log (compaction at ${compactionAt}, note at ${noteAt})`,
      );
    } finally {
      a.stop("test done");
    }
  });
});
