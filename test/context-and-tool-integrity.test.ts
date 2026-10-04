/**
 * #73 and #76 — the context-safety net and the tool-call protocol invariant.
 *
 * Both are "the defence exists but does not fire", which is the same shape as
 * #54 and #38: a fix that is present, correct, and inert.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// #110: POSIX-only — runs POSIX commands through the bash tool.
// The Windows CI job skips this file; see test/helpers/posix-only.ts for why
// opting out is explicit rather than by filename.
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

/* ---------- #73: an under-reported prompt_tokens must not disable the net ---------- */

test("a provider reporting a tiny prompt size still triggers compaction (#73)", async () => {
  await useTempDirs(["p73a-", "p73b-"], async ([ws, sd]) => {
    // ~40k characters of real conversation, but the provider claims 10 tokens.
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

    // The agent reports 10 tokens; the LOCAL estimate is ~40k chars.
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
  // the floor is loose on purpose — it must not argue with a real measurement
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

/* ---------- #76: every tool_call must be answered ---------- */

test("a tool_call left unanswered by an early exit is still answered (#76)", async () => {
  await useTempDirs(["p76a-", "p76b-"], async ([ws, sd]) => {
    // Two calls in ONE assistant message; the first is stop(), which returns
    // from the batch, so the second would never get a result.
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

    // Synthesise the failure the audit reproduced: an assistant turn with two
    // calls where only one was answered.
    const orphan = await agent.answerUnansweredToolCalls({
      role: "assistant",
      content: "",
      tool_calls: [tc("done1", "write_file", { path: "a.txt", content: "A" }), tc("lost", "bash", { command: "ls" })],
    } as never);
    assert.equal(orphan, undefined, "returns nothing (#76)");

    const answered = (agent.messages as any[]).filter((m) => m.role === "tool").map((m) => m.tool_call_id);
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
    (agent.messages as any[]).push({ role: "tool", tool_call_id: "already", content: "done" });
    await agent.answerUnansweredToolCalls({
      role: "assistant",
      content: "",
      tool_calls: [tc("already", "bash", { command: "ls" }), tc("fresh", "bash", { command: "pwd" })],
    } as never);
    const ids = (agent.messages as any[]).filter((m) => m.role === "tool" && m.tool_call_id === "already").length;
    assert.equal(ids, 1, `an answered call must not get a second result (#76); got ${ids}`);
    await agent.dispose();
  });
});

test("stop() then start() is not silently lost (#76)", async () => {
  // uses only the public API — the early-return guard was the defect, so the
  // test must not reach past it into private state to check the outcome
  await useTempDirs(["p76e-", "p76f-"], async ([ws, sd]) => {
    const agent = mkAgent(ws!, sd!, async () => ({ message: { role: "assistant" as const, content: "ok" } }));
    await agent.init();
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    // stop() only flips status via an ENQUEUED task, so status is still
    // "running" when start() is called a moment later
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

test("a context-overflow error is not retried before recovery sees it (#76)", () => {
  const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  // Anchor on the FLOW, not a fixed-width slice. The window was 2400 chars from
  // `llmCall`, and #37 added a comment block inside it that pushed this line
  // past the edge — so a correct check silently matched nothing. Rather than just
  // widening it again, find the line itself.
  const at = src.indexOf("if (isContextOverflow(err)) throw err;");
  assert.notEqual(at, -1, "overflow must bypass the retry loop (#76)");
  // `at + 64` so the line itself is inside the slice — a slice ENDING at the
  // match excludes the very text it is about to assert on
  const llmCall = src.slice(src.indexOf("private async llmCall("), at + 64);
  assert.match(
    llmCall,
    /if \(isContextOverflow\(err\)\) throw err;/,
    "overflow must bypass the retry loop (#76) — retrying an oversized request cannot succeed",
  );
});
