import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("runs POSIX commands through the bash tool");

const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

function mkAgent(ws: string, sd: string, chatFn: unknown, extra: Record<string, unknown> = {}) {
  return new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
    chatFn,
    autoContinue: false,
    ...extra,
  } as any);
}

test("a provider reporting a tiny prompt size still triggers compaction (#73)", async () => {
  await useTempDirs(["p73a-", "p73b-"], async ([ws, sd]) => {
    let n = 0;
    const big = "x".repeat(20_000);
    const agent = mkAgent(ws!, sd!, async () => {
      n++;
      if (n <= 2)
        return { message: { role: "assistant" as const, content: "", tool_calls: [tc(`w${n}`, "write_file", { path: `f${n}.txt`, content: big })] } };
      return { message: { role: "assistant" as const, content: "done" } };
    }, { contextTokenBudget: 6_000 });

    await agent.init();
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    await agent.settled();

    (agent as any).lastUsage = { input: 10, output: 1 };
    const raw = (agent as any).lastUsage.input;
    const size = (agent as any).contextSizeForBudgeting();
    assert.ok(
      size > raw,
      `budgeting must not believe the provider's ${raw} tokens when the local ` +
        `estimate is far higher (#73); got ${size}`,
    );
    assert.ok(
      size >= Math.floor((agent as any).estimateTokens() / 4),
      "the floor must reach at least half the local estimate (#73)",
    );
    await agent.dispose();
  });
});

test("a plausible provider report is still trusted (#73)", async () => {
  await useTempDirs(["p73c-", "p73d-"], async ([ws, sd]) => {
    const agent = mkAgent(ws!, sd!, async () => ({ message: { role: "assistant" as const, content: "ok" } }));
    await agent.init();
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    await agent.settled();
    (agent as any).lastUsage = { input: 900_000, output: 1 };
    assert.equal(
      (agent as any).contextSizeForBudgeting(),
      900_000,
      "a large real measurement must be used as-is (#73)",
    );
    await agent.dispose();
  });
});

test("a tool_call left unanswered by an early exit is still answered (#76)", async () => {
  await useTempDirs(["p76a-", "p76b-"], async ([ws, sd]) => {
    const agent = mkAgent(ws!, sd!, async () => ({
      message: {
        role: "assistant" as const,
        content: "",
        tool_calls: [tc("c1", "write_file", { path: "a.txt", content: "A" })],
      },
    }));
    await agent.init();
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    await agent.settled();

    const orphan = await agent.answerUnansweredToolCalls({
      role: "assistant",
      content: "",
      tool_calls: [tc("done1", "write_file", { path: "a.txt", content: "A" }), tc("lost", "bash", { command: "ls" })],
    } as never);
    assert.equal(orphan, undefined, "returns nothing (#76)");

    const answered = (agent.conversation as any[]).filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    assert.ok(
      answered.includes("lost"),
      `the orphaned call must get a result or the provider rejects the next request (#76); got ${JSON.stringify(answered)}`,
    );
    await agent.dispose();
  });
});

test("already-answered calls are not answered twice (#76)", async () => {
  await useTempDirs(["p76c-", "p76d-"], async ([ws, sd]) => {
    const agent = mkAgent(ws!, sd!, async () => ({ message: { role: "assistant" as const, content: "ok" } }));
    await agent.init();
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    await agent.settled();
    (agent.conversation as any[]).push({ role: "tool", tool_call_id: "already", content: "done" });
    await agent.answerUnansweredToolCalls({
      role: "assistant",
      content: "",
      tool_calls: [tc("already", "bash", { command: "ls" }), tc("fresh", "bash", { command: "pwd" })],
    } as never);
    const ids = (agent.conversation as any[]).filter((m) => m.role === "tool" && m.tool_call_id === "already").length;
    assert.equal(ids, 1, `an answered call must not get a second result (#76); got ${ids}`);
    await agent.dispose();
  });
});

test("stop() then start() is not silently lost (#76)", async () => {
  await useTempDirs(["p76e-", "p76f-"], async ([ws, sd]) => {
    const agent = mkAgent(ws!, sd!, async () => ({ message: { role: "assistant" as const, content: "ok" } }));
    await agent.init();
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    agent.stop("test");
    agent.start("restart");
    await agent.settled();
    await new Promise((r) => setTimeout(r, 50));
    assert.notEqual(
      agent.status,
      "stopped",
      "a start() after stop() must not be swallowed by the still-running status (#76)",
    );
    await agent.dispose();
  });
});

