import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("snapshot.pendingPrompts stays the DELIVERY counter (harness included) (#141 contract)", async () => {
  await useTempDirs(["d3a-", "d3b-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "c",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
      autoContinue: false,
    } as never) as Agent;
    try {
      await a.init();
      a.enqueuePrompt("[harness] child finished: report", "harness"); 
      a.enqueuePrompt("mine", "user"); 

      const s = a.snapshot();
      const ids = (s as unknown as { pendingPromptIds?: string[] }).pendingPromptIds ?? [];
      const queue = (s as unknown as { pendingPromptQueue?: unknown[] }).pendingPromptQueue ?? [];
      assert.equal(s.pendingPrompts, 2, "the delivery counter counts every queued prompt");
      assert.equal(ids.length, 1, "the cancellable set is the user prompt only");
      assert.equal(queue.length, 1, "the echoed queue matches the cancellable set");
    } finally {
      a.stop("end");
      await a.settled().catch(() => {});
      await a.dispose().catch(() => {});
    }
  });
});

