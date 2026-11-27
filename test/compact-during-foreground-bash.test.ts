/**
 * `/compact` asked for while a FOREGROUND command is running must queue — never answer "nothing to compact"
 * (#288).
 *
 * Reported: "フォアグラウンドbash実行中に /compact を実行したら nothing to compact yet が出た … manual compact では Immediate か
 * compact queued の2択しかありえない". The compaction itself then DID run when the command finished, so the request was honoured and only
 * the ANSWER was wrong — which is the more expensive half, because the operator cannot tell "queued" from "there is nothing here".
 *
 * `compactNow()` has four outcomes, and only two of them are answers a manual request may give: it ran, or it is queued. The
 * "nothing new" branch exists for the auto path and for a forced run that genuinely has nothing to do; reached from a manual request it
 * reports a state the operator did not ask about. The bug was the `parkedByTool` branch answering `{ran:false, queued:false}` — a
 * compaction that ran while a tool was executing and found nothing new looks identical to "your request was ignored".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const reply = (content: string): LlmResult => ({ message: { role: "assistant" as const, content } });
/**
 * The `chatFn` return shape is the LLM layer's `LlmResult`, whose tool calls travel as `tool_calls` in the OpenAI wire shape (the
 * internal `{name, args}` form is what the LOG and the tests' own fixtures use).
 */
const callBash = (command: string): LlmResult => ({
  message: {
    role: "assistant" as const,
    content: "",
    tool_calls: [{ id: "c1", type: "function" as const, function: { name: "bash", arguments: JSON.stringify({ command }) } }],
  },
});

const history = (n = 40) => {
  const msgs: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = 0; i < n; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `msg ${i} — filler` });
  return msgs;
};

test("a compact requested while a foreground command runs answers queued, and then runs", async () => {
  await useTempDirs(["cq1-", "cq1b-"], async ([ws, sd]) => {
    let calls = 0;
    const a = new Agent({
      id: "cq",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => {
        calls++;
        // the first request asks for a command that outlives the next call, so `/compact` lands mid-execution
        if (calls === 1) return callBash("sleep 1.5");
        return reply("done");
      },
      autoContinue: false,
    } as never) as Agent;

    try {
      await a.init();
      (a as unknown as { messages: unknown[] }).messages = history();
      a.start("go");

      // wait until the command is genuinely executing — otherwise the request is not "during a foreground bash"
      const deadline = Date.now() + 8000;
      while (!a.isBusy?.() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 120));

      const answer = await a.compactNow();
      assert.equal(
        answer.queued || answer.ran,
        true,
        `a manual compact during a running command must answer "queued" or "ran", got ${JSON.stringify(answer)} — ` +
          "'nothing to compact yet' about a history nobody examined is what #288 reported",
      );
      if (answer.queued) {
        // and the queue must actually be honoured: the compaction runs once the turn reaches a boundary
        const done = Date.now() + 15000;
        let compacted = false;
        while (Date.now() < done) {
          if ((a as unknown as { stats: { compactions: number } }).stats.compactions > 0) {
            compacted = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(compacted, true, "the queued compaction never ran after the command finished");
      }
    } finally {
      a.stop();
    }
  });
});
