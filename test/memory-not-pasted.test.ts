/**
 * memory.md is never pasted into the conversation, and a comment-only memory is not "notes".
 *
 * MEASURED from mediapad-t5-root-attempt-2: a compaction re-attached memory.md "almost whole" and what it pasted was one
 * line — `<!-- migrated from session solidocs-9d8ebb6e -->`. The operator's question was the right one: "なんでmemoryを
 * ほぼ全注入してるの?" The system prompt already carries a digest of memory.md (headings plus one line each, with
 * "call read_memory(query) to search the rest") and that digest survives a compaction, so the paste added nothing — and
 * it made the post-compaction prompt differ between runs, which the provider's prefix cache pays for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

test("a compaction does not paste memory.md into the conversation", async () => {
  await useTempDirs(["mn-", "mn-sd-"], async ([ws, sd]) => {
    let n = 0;
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => {
        n += 1;
        return { message: { role: "assistant", content: `reply ${n} ${"q".repeat(700)}` } };
      },
      contextTokenBudget: 1_500,
      autoContinue: false,
    } as never) as InstanceType<typeof Agent>;
    await a.init();
    try {
      // a memory file whose only content is a provenance marker — what the operator saw pasted
      writeFileSync(path.join(sd!, "memory.md"), "<!-- migrated from session solidocs-9d8ebb6e -->\n");
      for (let i = 0; i < 8; i++) {
        a.enqueuePrompt(`go ${i}`, "user");
        a.start("t");
        await a.settled();
      }
      await a.compactNow();
      const convo = JSON.stringify(a.conversation);
      assert.equal(
        convo.includes("migrated from session"),
        false,
        "the memory file must not be pasted; the digest in the system prompt is what the model reads",
      );
      assert.equal(convo.includes("re-attached after compaction — this is what earlier you chose to remember"), false);
    } finally {
      a.stop("test done");
    }
  });
});

test("a comment-only memory file produces no digest", async () => {
  await useTempDirs(["mn2-", "mn2-sd-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => ({ message: { role: "assistant", content: "ok" } }),
      autoContinue: false,
    } as never) as InstanceType<typeof Agent>;
    await a.init();
    try {
      writeFileSync(path.join(sd!, "memory.md"), "<!-- migrated from session solidocs-9d8ebb6e -->\n");
      const sys = (a as unknown as { systemPrompt: () => string }).systemPrompt();
      assert.equal(
        sys.includes("migrated from session"),
        false,
        "a marker comment is not a memory; injecting it only adds noise to every request",
      );
    } finally {
      a.stop("test done");
    }
  });
});
