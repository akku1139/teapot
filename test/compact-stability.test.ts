/**
 * #8 — "behaviour becomes unstable after compact()"
 *
 * Compaction rewrites history by dropping a PREFIX. The one invariant that
 * makes a prefix-drop safe is that the kept tail never starts on a dangling
 * `tool` message — an assistant turn that issued tool_calls must keep its
 * results, or the provider rejects the next request with a 400 ("messages with
 * role 'tool' must be a response to a preceding message with tool_calls").
 * That error is the "unstable after compact" symptom.
 *
 * The summarize path guards this with safeCut(). The TRUNCATE fallback — taken
 * when the summarizer call fails — cut with safeCut(halfCut) relative to a
 * different base and was the weak spot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
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

/** Every tool_call id that has a matching tool result, and vice versa. */
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
      const sys = String(messages[0]?.content ?? "");
      if (sys.includes("You compress a coding agent's conversation")) return reply("- summary of earlier work");
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
    assertPaired(agent.messages as ChatMessage[], "summarize path");
    await agent.dispose();
  });
});

test("compaction leaves no dangling tool results when the summarizer FAILS (#8)", async () => {
  // the truncation fallback must satisfy the same invariant as the summarize
  // path, or the very next provider call 400s
  await useTempDirs(["c8c-", "c8d-"], async ([ws, sessionDir]) => {
    const big = "x".repeat(2000);
    let n = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      n++;
      const sys = String(messages[0]?.content ?? "");
      // fail ONLY the summarizer call (its system prompt is distinctive), so the
      // main loop survives and reaches the truncation fallback
      if (sys.includes("You compress a coding agent's conversation"))
        throw new Error("summarizer unavailable");
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
    // The regression (#8): with the summarizer down, the fallback used
    // safeCut(floor(oldCount/2)) which rounds to 0 on a short history, so it
    // bailed out SILENTLY — compactions stayed 0, the messages were untouched,
    // and the context was still over budget, guaranteeing the next provider
    // call overflowed. Truncation must always make progress.
    assert.equal(agent.stats.compactions, 1, "compaction ran despite the summarizer failing");
    assert.ok(
      (agent.messages as ChatMessage[]).length < 4,
      `truncation must drop messages, got ${(agent.messages as ChatMessage[]).length}`,
    );
    assertPaired(agent.messages as ChatMessage[], "truncate fallback");
    await agent.dispose();
  });
});

test("a second compaction after the first stays well-formed (#8)", async () => {
  // "unstable AFTER compact" often means the SECOND round trip breaks, because
  // state carried across compactions (compactedAtLen, kept tail) is stale.
  await useTempDirs(["c8e-", "c8f-"], async ([ws, sessionDir]) => {
    const big = "x".repeat(2000);
    let n = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      n++;
      const sys = String(messages[0]?.content ?? "");
      if (sys.includes("You compress a coding agent's conversation")) return reply("- summary");
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
      assertPaired(agent.messages as ChatMessage[], `after round ${i}`);
    }
    await agent.dispose();
  });
});

test("history stays pairable after a restart that follows a compaction (#8)", async () => {
  // compactedAtLen is in-memory only; stats.compactions is rebuilt from the
  // log. If the restored history disagrees with the log, the next compaction
  // can cut mid-exchange.
  await useTempDirs(["c8g-", "c8h-"], async ([ws, sessionDir]) => {
    const big = "x".repeat(2000);
    let n = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      n++;
      const sys = String(messages[0]?.content ?? "");
      if (sys.includes("You compress a coding agent's conversation")) return reply("- summary");
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

    // same session dir, fresh process-equivalent state
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
    assertPaired(second.messages as ChatMessage[], "after restart + second compaction");
    assert.ok(
      second.stats.compactions >= 1,
      "lifetime compaction count must survive the restart",
    );
    await second.dispose();
  });
});

/* ---------- safeCut is the guard both paths rely on ---------- */

test("safeCut never leaves the kept tail starting on a dangling tool result", async () => {
  await useTempDirs(["c8i-", "c8j-"], async ([ws, sessionDir]) => {
    const agent = new Agent({
      id: "t", workspace: ws, sessionDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async () => reply("x"), autoContinue: false,
    } as any);
    await agent.init();
    // build a history whose tail region is dense with tool results
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
      if (i < 0) continue; // nothing safely cuttable
      const kept = msgs.slice(i);
      const orphans = auditPairing(kept).orphanResults;
      assert.deepEqual(orphans, [], `safeCut(${cut}) -> start ${i} left dangling results`);
    }
    await agent.dispose();
  });
});