/**
 * A round that DID work and then answered "ok" must end that round.
 *
 * MEASURED (and the cause of two OOM kills): the bare-acknowledgement rule fired for any short reply, including one that
 * followed real work. The loop then forced another turn, and its own stall guard could not stop it — that counter is
 * RESET by work tools, which is exactly what the round had done. One test wrote 8GB of chat.jsonl and had to be killed.
 *
 * The contract: "acknowledgement" means the round acknowledged and did nothing else.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (content: string, calls?: ReturnType<typeof tc>[]): LlmResult => ({
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
});

test("work followed by 'ok' ends the round instead of looping for ever", async () => {
  await useTempDirs(["ackloop-", "ackloop-sd-"], async ([ws, sd]) => {
    let calls = 0;
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => {
        calls += 1;
        if (calls % 2 === 1) return reply("writing", [tc(`w${calls}`, "write_file", { path: `f${calls}.txt`, content: "x".repeat(500) })]);
        return reply("ok"); // a short acknowledgement AFTER work: the round is over
      },
      contextTokenBudget: 200,
      autoContinue: false,
      maxTurnsPerRound: 8,
    } as never) as InstanceType<typeof Agent>;
    await a.init();
    a.enqueuePrompt("go", "user");
    a.start("t");
    try {
      await a.settled();
      assert.ok(calls <= 4, `the round must end, not force another turn for ever (llm calls: ${calls})`);
      const size = statSync(`${sd}/chat.jsonl`).size;
      assert.ok(size < 500_000, `the log must stay small; got ${size} bytes — this is the 8GB runaway`);
    } finally {
      a.stop("test done");
    }
  });
});
