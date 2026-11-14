import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { isSummarizerRequest } from "./helpers/summarizer-request.ts";
import { Agent } from "../src/agent/agent.ts";
import { feedCandidates } from "../frontend/lib/timeline.ts";
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
      "TODO: splice work, round 3\nthese notes are context around the list\n- [ ] fix the splice\n- [x] already done\n- [ ] verify on the device\n",
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
    /**
     * The whole list, not just the unchecked lines: todo.md is free-form, so filtering to `- [ ]` lines would drop
     * the paragraphs around them. The only omission is a list that is ALL done — nothing actionable remains.
     */
    assert.match(attached!, /TODO: splice work, round 3/, "including the prose around the list");
    assert.match(attached!, /- \[ \] fix the splice/, "and every item, done or not");
    assert.match(attached!, /- \[ \] verify on the device/, "and every open item, in order");
    assert.match(attached!, /already done/, "done items are kept: they are what makes the open ones legible");
    await agent.dispose();
  });
});

/**
 * The re-attached note is for the MODEL: it must not be drawn in the timeline (#263).
 *
 * It restates the goal and the task list the model already had, so as a harness message it read like the operator had typed
 * something during compaction. The log keeps the row (a restart rebuilds the conversation from it); the feed drops it.
 */
test("the re-attach note is logged hidden, so the feed skips it while the conversation keeps it", () => {
  const note = {
    id: "e1",
    seq: 1,
    type: "prompt" as const,
    agent: "a",
    session: "s",
    branch: "main",
    ts: "2026-01-01T00:00:00.000Z",
    data: { source: "harness", text: "re-attached after compaction", hidden: true },
  };
  const visible = feedCandidates({
    events: [note] as never,
    pending: [],
    consumed: new Set<string>(),
    feedTypes: new Set(["prompt"]),
    renderedTypes: new Set(["prompt"]),
    renderedNoteEvents: new Set<string>(),
    echo: (p) => p as never,
  });
  assert.equal(visible.length, 0, "a hidden prompt is not a feed row");

  const shown = feedCandidates({
    events: [{ ...note, data: { source: "harness", text: "visible note" } }] as never,
    pending: [],
    consumed: new Set<string>(),
    feedTypes: new Set(["prompt"]),
    renderedTypes: new Set(["prompt"]),
    renderedNoteEvents: new Set<string>(),
    echo: (p) => p as never,
  });
  assert.equal(shown.length, 1, "a normal harness prompt still renders — the flag is what hides, not the source");
});
