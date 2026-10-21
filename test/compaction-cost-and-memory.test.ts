/**
 * Compaction cost and memory behaviour, after a survey of how other harnesses do it.
 *
 * MEASURED first, on this repo's own compaction call: the main loop sends
 * `[system(coding agent), ...messages]` while the summarizer sends
 * `[system(compressor), user(flat transcript)]`. The FIRST message differs, so no
 * cacheable prefix is shared and the entire history is re-prefilled and re-billed
 * at the summarizer's own full size.
 *
 * Every implementation surveyed (Pi, Codex, opencode, Kilo, Aider) engineers around
 * that fact rather than trying to share the prefix:
 *
 *   - Pi: `cacheRetention: "none"` — "summarization requests disable prompt-cache
 *     writes because these one-off prompts are unlikely to be reused"
 *   - Codex: trims "from the beginning to preserve cache (prefix-based)"
 *   - opencode/Kilo/Pi: UPDATE the previous summary instead of re-deriving it
 *   - opencode: `SHRINK_STEPS [0.7, 0.5, 0.35]` on repeated overflow
 *   - all: never cut inside a tool-call/result pair
 *
 * These tests pin what teapot now does about each.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";

import { cacheControlForRequest, type LlmConfig } from "../src/agent/llm.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { isSummarizerRequest } from "./helpers/summarizer-request.ts";
import type { LlmResult } from "../src/agent/llm.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { rm } from "node:fs/promises";

const OR: LlmConfig = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "m" };
const OTHER: LlmConfig = { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m" };

/* ---------- 1. cache control on the one-off call ---------- */

test("a one-off summarize call asks the endpoint not to retain the prompt", () => {
  // the saving is real: a cache WRITE premium paid for a prompt that is never read
  // back is pure loss
  assert.deepEqual(cacheControlForRequest({ ...OR, oneOff: true }), { prompt_cache_retention: "24h" });
});

test("the main loop does NOT carry the directive — its prefix IS reused", () => {
  assert.deepEqual(cacheControlForRequest(OR), {}, "an ordinary turn must keep caching");
});

test("a provider that was not verified to accept the field gets NOTHING", () => {
  // sending an unknown body field is a 400 on strict OpenAI-compatible endpoints,
  // and "send nothing" is exactly the previous behaviour, so this can only help
  assert.deepEqual(cacheControlForRequest({ ...OTHER, oneOff: true }), {});
});

/* ---------- 2. the summarize call is skipped when it is not worth it ---------- */

const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

/**
 * Every workspace/session dir this file created, removed once the file's tests finish.
 *
 * `after` rather than per-test `finally` because the helper is shared by six tests and threading
 * the paths back through each of them adds noise for no benefit — the file's lifetime is the
 * right scope for cleanup.
 */
const madeDirs: string[] = [];
after(async () => {
  for (const d of madeDirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  madeDirs.length = 0;
});

/** an agent whose chatFn answers, and records whether the summarizer was called */
async function compactingAgent(opts: {
  budget: number;
  rounds: number;
  promptChars: number;
}) {
  const ws = mkdtempInRootSync("ci-");
  const sd = mkdtempInRootSync("cis-");
  let summaries = 0;
  let n = 0;
  const chatFn = async (_c: unknown, messages: unknown): Promise<LlmResult> => {
    if (isSummarizerRequest(messages)) {
      summaries++;
      return { message: { role: "assistant", content: "- distilled notes" } };
    }
    // every turn issues a large tool call, so the history grows on both sides
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
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as LlmConfig,
    chatFn,
    contextTokenBudget: opts.budget,
    autoContinue: false,
  } as never);
  await agent.init();
  for (let i = 0; i < opts.rounds; i++) {
    agent.enqueuePrompt(`step ${i} ${"y".repeat(opts.promptChars)}`);
    agent.start("t");
    await agent.settled();
  }
  /**
   * Register the directories for removal when this test file finishes.
   *
   * MEASURED: this helper writes ~1000 files per invocation and its six tests each called it,
   * leaving 40 directories of ~6.4MB in `/tmp/teapot-tests` — 195MB, the single largest source
   * of litter. `dispose()` closes the log; it does not delete the workspace, and nothing else
   * did either.
   */
  madeDirs.push(ws, sd);
  return { agent, summaries: () => summaries };
}

test("a DEEP history is summarized rather than dropped", async () => {
  const { agent, summaries } = await compactingAgent({ budget: 8000, rounds: 6, promptChars: 12_000 });
  try {
    assert.ok(agent.stats.compactions >= 1, "the budget must have been enforced");
    assert.ok(summaries() >= 1, "a long history earns the summarize call");
    assert.match(
      String(agent.conversation[0]?.content ?? ""),
      /## Summary of earlier conversation/,
      "and the notes are what the model is left with",
    );
  } finally {
    await agent.dispose();
  }
});

test("the cost decision is RECORDED, so it is auditable rather than invisible", async () => {
  const { agent } = await compactingAgent({ budget: 8000, rounds: 3, promptChars: 12_000 });
  try {
    const notes = (await readEvents(agent.log.filePath))
      .filter((e) => e.type === "system_note")
      .map((e) => e.data as Record<string, unknown>);
    const started = notes.find((d) => d.event === "context-compaction-started");
    assert.ok(started, "the pass must announce itself");
    assert.equal(typeof started.worthSummarizing, "boolean", "and say whether it paid for a call");
    assert.equal(typeof started.updating, "boolean", "and whether it updated or started fresh");
  } finally {
    await agent.dispose();
  }
});

/* ---------- 3. update mode: notes are carried forward ---------- */

test("a SECOND compaction UPDATES the previous notes instead of starting over", async () => {
  const { agent } = await compactingAgent({ budget: 8000, rounds: 8, promptChars: 12_000 });
  try {
    const started = (await readEvents(agent.log.filePath))
      .filter((e) => e.type === "system_note")
      .map((e) => e.data as Record<string, unknown>)
      .filter((d) => d.event === "context-compaction-started");
    assert.ok(started.length >= 2, `expected repeated compaction, got ${started.length}`);
    assert.equal(started[0]!.updating, false, "the first pass has nothing to update");
    assert.ok(
      started.slice(1).some((d) => d.updating === true),
      "later passes must carry the previous notes forward — re-deriving them loses what the last pass distilled",
    );
  } finally {
    await agent.dispose();
  }
});

test("the previous notes are in the summarizer's INPUT, not just its instructions", async () => {
  // opencode/Kilo/Pi all pass the prior summary as input. If only the prompt said
  // "update the notes" without including them, the model would have nothing to
  // update and the section would silently become a fresh summary.
  const ws = mkdtempInRootSync("cu-");
  const sd = mkdtempInRootSync("cus-");
  madeDirs.push(ws, sd);
  let sawPriorNotes = false;
  let n = 0;
  const chatFn = async (_c: unknown, messages: unknown): Promise<LlmResult> => {
    const msgs = messages as { role: string; content?: string }[];
    if (isSummarizerRequest(msgs)) {
      // the prior notes ride in the TRAILING message now, framed as a checkpoint —
      // the request prefix is the conversation's own, so there is no other slot
      const user = String(msgs[msgs.length - 1]?.content ?? "");
      if (user.includes("<conversation_checkpoint>") && user.includes("NOTES-")) sawPriorNotes = true;
      return { message: { role: "assistant", content: `- NOTES-${n++}` } };
    }
    return {
      message: {
        role: "assistant",
        content: "working",
        tool_calls: [tc(`w${n}`, "write_file", { path: `h${n}.txt`, content: "x".repeat(200) })],
      },
    };
  };
  const agent = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as LlmConfig,
    chatFn,
    contextTokenBudget: 8000,
    autoContinue: false,
  } as never);
  await agent.init();
  try {
    for (let i = 0; i < 8; i++) {
      agent.enqueuePrompt(`step ${i} ${"y".repeat(12_000)}`);
      agent.start("t");
      await agent.settled();
    }
    assert.ok(sawPriorNotes, "a later summarize pass must receive the notes it is updating");
  } finally {
    await agent.dispose();
  }
});

/* ---------- 4. truncation is no longer SILENT ---------- */

test("dropping history tells the model, so a gap is not mistaken for a fact", async () => {
  // The sharpest failure of a silent cut: the model sees a conversation starting
  // mid-way and cannot tell "I forgot" from "this never happened".
  const ws = mkdtempInRootSync("ct-");
  const sd = mkdtempInRootSync("cts-");
  madeDirs.push(ws, sd);
  let n = 0;
  const chatFn = async (_c: unknown, messages: unknown): Promise<LlmResult> => {
    if (isSummarizerRequest(messages)) throw new Error("summarizer down — force the truncate path");
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
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as LlmConfig,
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
    assert.ok(agent.stats.compactions >= 1, "the fallback must still reclaim the budget");
    assert.match(
      String(agent.conversation[0]?.content ?? ""),
      /DROPPED, not summarized/,
      "the model must be told its prefix is gone, not left to infer it",
    );
  } finally {
    await agent.dispose();
  }
});

/* ---------- 5. the tool-pairing invariant survives every path ---------- */

test("no compaction path leaves a dangling tool result (provider 400)", async () => {
  const { agent } = await compactingAgent({ budget: 8000, rounds: 8, promptChars: 12_000 });
  try {
    const called = new Set<string>();
    const answered = new Set<string>();
    for (const m of agent.conversation) {
      for (const t of m.tool_calls ?? []) called.add(t.id);
      if (m.tool_call_id) answered.add(m.tool_call_id);
    }
    const orphan = [...answered].filter((id) => !called.has(id));
    assert.deepEqual(orphan, [], `a kept tool result without its call is a hard 400 (#8): ${orphan}`);
  } finally {
    await agent.dispose();
  }
});
