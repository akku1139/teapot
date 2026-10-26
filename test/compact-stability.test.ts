import { test } from "node:test";
import assert from "node:assert/strict";
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

function auditPairing(msgs: ChatMessage[]): { orphanResults: string[]; orphanCalls: string[] } {
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const m of msgs) {
    for (const t of m.tool_calls ?? []) called.add(t.id);
    if (m.tool_call_id) answered.add(m.tool_call_id);
  }
  return {
    orphanResults: [...answered].filter((id) => !called.has(id)),
    orphanCalls: [...called].filter((id) => !answered.has(id)),
  };
}

function assertPaired(msgs: ChatMessage[], label: string): void {
  const { orphanResults } = auditPairing(msgs);
  assert.deepEqual(orphanResults, [], `${label}: dangling tool results (provider 400): ${orphanResults}`);
}

test("compaction leaves no dangling tool results when summarizing (#8)", async () => {
  await useTempDirs(["c8a-", "c8b-"], async ([ws, sessionDir]) => {
    const big = "x".repeat(2000);
    let n = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      n++;
      if (isSummarizerRequest(messages)) return reply("- summary of earlier work");
      if (n === 1)
        return reply("writing", [tc("w1", "write_file", { path: "big.txt", content: big })]);
      return reply("done");
    };
    const agent = new Agent({
      id: "t", workspace: ws, sessionDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn, contextTokenBudget: 200, autoContinue: false,
    } as any);
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    assert.equal(agent.stats.compactions, 1, "compaction ran");
    assertPaired(agent.conversation as ChatMessage[], "summarize path");
    await agent.dispose();
  });
});

test("compaction leaves no dangling tool results when the summarizer FAILS (#8)", async () => {
  await useTempDirs(["c8c-", "c8d-"], async ([ws, sessionDir]) => {
    const big = "x".repeat(2000);
    let n = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      n++;
      if (isSummarizerRequest(messages)) throw new Error("summarizer unavailable");
      if (n === 1)
        return reply("writing", [tc("w1", "write_file", { path: "big.txt", content: big })]);
      return reply("done");
    };
    const agent = new Agent({
      id: "t", workspace: ws, sessionDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn, contextTokenBudget: 200, autoContinue: false,
    } as any);
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    assert.equal(agent.stats.compactions, 1, "compaction ran despite the summarizer failing");
    assert.ok(
      (agent.conversation as ChatMessage[]).length < 5,
      `truncation must drop messages, got ${(agent.conversation as ChatMessage[]).length}`,
    );
    assert.match(
      String((agent.conversation as ChatMessage[])[0]!.content ?? ""),
      /DROPPED, not summarized/,
      "the model must be TOLD its prefix was dropped, not left to guess (#8)",
    );
    assertPaired(agent.conversation as ChatMessage[], "truncate fallback");
    await agent.dispose();
  });
});

test("a second compaction after the first stays well-formed (#8)", async () => {
  await useTempDirs(["c8e-", "c8f-"], async ([ws, sessionDir]) => {
    const big = "x".repeat(2000);
    let n = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      n++;
      if (isSummarizerRequest(messages)) return reply("- summary");
      if (n % 2 === 1)
        return reply("writing", [tc(`w${n}`, "write_file", { path: `f${n}.txt`, content: big })]);
      return reply("ok");
    };
    const agent = new Agent({
      id: "t", workspace: ws, sessionDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn, contextTokenBudget: 200, autoContinue: false,
    } as any);
    await agent.init();
    for (let i = 0; i < 3; i++) {
      agent.enqueuePrompt(`round ${i}`);
      agent.start("t");
      await agent.settled();
      assertPaired(agent.conversation as ChatMessage[], `after round ${i}`);
    }
    await agent.dispose();
  });
});

test("history stays pairable after a restart that follows a compaction (#8)", async () => {
  await useTempDirs(["c8g-", "c8h-"], async ([ws, sessionDir]) => {
    const big = "x".repeat(2000);
    let n = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      n++;
      if (isSummarizerRequest(messages)) return reply("- summary");
      if (n === 1)
        return reply("writing", [tc("w1", "write_file", { path: "big.txt", content: big })]);
      return reply("done");
    };
    const first = new Agent({
      id: "t", workspace: ws, sessionDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn, contextTokenBudget: 200, autoContinue: false,
    } as any);
    await first.init();
    first.enqueuePrompt("go");
    first.start("t");
    await first.settled();
    assert.equal(first.stats.compactions, 1);
    await first.dispose();

    const second = new Agent({
      id: "t", workspace: ws, sessionDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn, contextTokenBudget: 200, autoContinue: false,
      restoreSession: true,
    } as any);
    await second.init();
    second.enqueuePrompt("again");
    second.start("t");
    await second.settled();
    assertPaired(second.conversation as ChatMessage[], "after restart + second compaction");
    assert.ok(
      second.stats.compactions >= 1,
      "lifetime compaction count must survive the restart",
    );
    await second.dispose();
  });
});

test("safeCut never leaves the kept tail starting on a dangling tool result", async () => {
  await useTempDirs(["c8i-", "c8j-"], async ([ws, sessionDir]) => {
    const agent = new Agent({
      id: "t", workspace: ws, sessionDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async () => reply("x"), autoContinue: false,
    } as any);
    await agent.init();
    const msgs: ChatMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b", tool_calls: [tc("c1", "read_file", { path: "x" })] as any },
      { role: "tool", tool_call_id: "c1", content: "r1" },
      { role: "assistant", content: "d", tool_calls: [tc("c2", "read_file", { path: "y" })] as any },
      { role: "tool", tool_call_id: "c2", content: "r2" },
      { role: "assistant", content: "e", tool_calls: [tc("c3", "read_file", { path: "z" })] as any },
      { role: "tool", tool_call_id: "c3", content: "r3" },
    ];
    (agent as unknown as { messages: ChatMessage[] }).messages = msgs;
    for (let cut = 0; cut <= msgs.length; cut++) {
      const i = (agent as unknown as { safeCut(n: number): number }).safeCut(cut);
      if (i < 0) continue; 
      const kept = msgs.slice(i);
      const orphans = auditPairing(kept).orphanResults;
      assert.deepEqual(orphans, [], `safeCut(${cut}) -> start ${i} left dangling results`);
    }
    await agent.dispose();
  });
});