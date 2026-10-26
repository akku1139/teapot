/**
 * The summarizer call must be a genuine PREFIX EXTENSION of the conversation call.
 *
 * This is the measured claim the whole shape exists for: a provider caches on the
 * leading token sequence, so if the summarizer request starts with anything other
 * than the conversation's own first message, nothing is cacheable and the entire
 * history is re-prefilled at full price — exactly when the history is largest.
 *
 * DeepSeek Harness documents the same finding and fix (its
 * `compaction-summary-prefix-cache-reuse` note): the directive moves from the FRONT
 * of the request to the END, so the auxiliary call replays the conversation's system
 * prompt, tools, and leading messages verbatim and appends one trailing instruction.
 *
 * Asserted here on the REAL request objects, through the real agent, because the
 * property is about byte-identical message arrays and not about a helper.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent/agent.ts";
import type { ChatMessage, LlmResult } from "../src/agent/llm.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { readEvents } from "../src/log/events.ts";

const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

interface Recorded {
  messages: ChatMessage[];
  tools: unknown[];
  isSummarizer: boolean;
}

/** drive an agent until it compacts, recording every request it makes */
async function drive(budget = 8000, rounds = 6) {
  const ws = mkdtempInRootSync("pc-");
  const sd = mkdtempInRootSync("pcs-");
  const seen: Recorded[] = [];
  let n = 0;
  const chatFn = async (_c: unknown, messages: ChatMessage[], tools: unknown[]): Promise<LlmResult> => {
    const msgs = messages as ChatMessage[];
    // the summarizer is the request whose LAST message carries the directive
    const last = msgs[msgs.length - 1]?.content ?? "";
    const isSummarizer = String(last).includes("You compress a coding agent's conversation");
    seen.push({ messages: msgs.map((m) => ({ ...m })), tools, isSummarizer });
    if (isSummarizer) return { message: { role: "assistant", content: "## Current work\n- notes" } };
    return {
      message: {
        role: "assistant",
        content: "working",
        tool_calls: [tc(`w${n++}`, "write_file", { path: `f${n}.txt`, content: "e".repeat(200) })],
      },
    };
  };
  const agent = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn,
    contextTokenBudget: budget,
    autoContinue: false,
  } as never);
  await agent.init();
  for (let i = 0; i < rounds; i++) {
    agent.enqueuePrompt(`step ${i} ${"y".repeat(12_000)}`);
    agent.start("t");
    await agent.settled();
  }
  return { agent, seen };
}

test("the summarizer request REPLAYS the conversation's own first message (#150 prefix cache)", async () => {
  const { agent, seen } = await drive();
  try {
    const summaries = seen.filter((s) => s.isSummarizer);
    const ordinary = seen.filter((s) => !s.isSummarizer);
    assert.ok(summaries.length >= 1, "the fixture must reach the summarizer");
    assert.ok(ordinary.length >= 2, "and must have made conversation calls");

    const convo = ordinary[0]!;
    const sum = summaries[0]!;
    // THE claim: the first message is the conversation's, byte for byte — not a
    // bespoke summarizer system prompt, which would invalidate the whole prefix
    assert.equal(
      sum.messages[0]!.role,
      "system",
      "the summarizer must start with the conversation's system message",
    );
    assert.equal(
      sum.messages[0]!.content,
      convo.messages[0]!.content,
      "and its content must be IDENTICAL, or the provider caches nothing (#150)",
    );
    // tools are part of the cached token sequence
    assert.equal(
      JSON.stringify(sum.tools),
      JSON.stringify(convo.tools),
      "the tool schemas must ride along — dropping them misaligns every following token",
    );
    // the directive is LAST, so the replayed messages are a true prefix
    const last = sum.messages[sum.messages.length - 1]!;
    assert.equal(last.role, "user", "the instruction is a trailing user message");
    assert.match(String(last.content), /You compress a coding agent's conversation/);
  } finally {
    await agent.dispose();
  }
});

test("no summarizer request introduces a DIFFERENT system prompt (#150)", async () => {
  const { agent, seen } = await drive();
  try {
    const systems = new Set(seen.map((s) => String(s.messages[0]?.content ?? "")));
    assert.equal(
      systems.size,
      1,
      `every request must share one system prompt, or the prefix cache is defeated per call: ${systems.size} distinct`,
    );
  } finally {
    await agent.dispose();
  }
});

test("the summarizer's own usage is LOGGED, so cache reuse is observable (#150)", async () => {
  // The shape above is asserted on the request. Whether the provider actually
  // SERVED that prefix from its cache is only visible in the response's
  // `cachedInputTokens` — and teapot used to throw the summarizer's usage away, so
  // the claim could not be checked at all. MEASURED on the 12k-event session that
  // prompted this: 2342 usage events, none of them the summarizer's.
  //
  // A number no log line carries cannot be verified, and an unverifiable claim is
  // how a shape silently stops being a prefix extension without anyone noticing.
  const ws = mkdtempInRootSync("pcu-");
  const sd = mkdtempInRootSync("pcus-");
  let n = 0;
  let summarizerCalls = 0;
  const chatFn = async (_c: unknown, messages: ChatMessage[]): Promise<LlmResult> => {
    const last = String(messages[messages.length - 1]?.content ?? "");
    if (last.includes("You compress a coding agent's conversation")) {
      summarizerCalls++;
      // the provider's answer for a cacheable prefix: most of the prompt served
      return {
        message: { role: "assistant", content: "## Current work\n- notes" },
        usage: { inputTokens: 5000, outputTokens: 40, cachedInputTokens: 4800 },
      };
    }
    return {
      message: {
        role: "assistant",
        content: "working",
        tool_calls: [tc(`u${n++}`, "write_file", { path: `u${n}.txt`, content: "e".repeat(200) })],
      },
      usage: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 },
    };
  };
  const agent = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn,
    contextTokenBudget: 8000,
    autoContinue: false,
  } as never);
  await agent.init();
  try {
    for (let i = 0; i < 6; i++) {
      agent.enqueuePrompt(`step ${i} ${"y".repeat(12_000)}`);
      agent.start("t");
      await agent.settled();
    }
    assert.ok(summarizerCalls >= 1, "the fixture must reach the summarizer");
    const usage = await readEvents(agent.log.filePath);
    const sumUsage = usage.filter((e) => e.type === "usage" && (e.data as { kind?: string }).kind === "summarize");
    assert.equal(
      sumUsage.length,
      summarizerCalls,
      "every summarizer call must log its usage, or cache reuse stays unverifiable (#150)",
    );
    const d = sumUsage[0]!.data as { inputTokens?: number; cachedInputTokens?: number };
    assert.equal(d.inputTokens, 5000);
    assert.equal(
      d.cachedInputTokens,
      4800,
      "the cached share is THE measurement of prefix reuse — it must survive into the log",
    );
  } finally {
    await agent.dispose();
  }
});
