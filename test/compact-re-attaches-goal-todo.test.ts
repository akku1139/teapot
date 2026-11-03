import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { isSummarizerRequest } from "./helpers/summarizer-request.ts";
import { Agent } from "../src/agent/agent.ts";
import type { ChatMessage, LlmResult } from "../src/agent/llm.ts";

const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (content: string, calls?: ReturnType<typeof tc>[]): LlmResult => ({
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
});

test("compaction re-attaches the goal and the OPEN tasks, not just the summary", async () => {
  /**
   * "compact後にアクティブなgoalとかTODOリストを再入とかしてる? それしないと見失いそうだけど (TODOは更新せずに作業
   * 終わることがあるからなんとも言えないけど)".
   *
   * memory, files and AGENTS.md were re-attached; the two things that actually drive the work — the goal and what is
   * left — were only implicit in the checkpoint the summariser wrote. One omission there and the agent drifts onto a
   * summary of itself.
   */
  await useTempDirs(["cg1-", "cg1b-"], async ([ws, sessionDir]) => {
    const big = "x".repeat(2000);
    writeFileSync(
      `${sessionDir}/todo.md`,
      "- [ ] fix the splice\n- [x] already done\n- [ ] verify on the device\n",
    );
    let n = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      n++;
      if (isSummarizerRequest(messages)) return reply("- summary of earlier work");
      if (n === 1) return reply("writing", [tc("w1", "write_file", { path: "big.txt", content: big })]);
      return reply("done");
    };
    const agent = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sessionDir!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn,
      contextTokenBudget: 200,
      autoContinue: false,
    } as never);
    await agent.init();
    await agent.setGoal("keep going until the splice is verified");
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    assert.equal(agent.stats.compactions, 1, "compaction ran");

    const texts = (agent.conversation as ChatMessage[]).map((m) => String(m.content ?? ""));
    const attached = texts.find((t) => t.includes("re-attached after compaction"));
    assert.ok(attached, "the goal/todo re-attachment must exist");
    assert.match(attached!, /keep going until the splice is verified/, "and carry the goal verbatim");
    assert.match(attached!, /fix the splice\n- \[ \] verify on the device/, "and the open tasks, in order");
    assert.doesNotMatch(
      attached!,
      /already done/,
      "a finished item is noise after a compaction — only what is left is re-attached",
    );
    await agent.dispose();
  });
});
