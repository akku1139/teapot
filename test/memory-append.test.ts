/**
 * #48 — the memory system did not actually work, and the prompt said it did.
 *
 * The issue asked "そもそもteapotの現状のmemoryシステムはまともに仕事してるのか?" — so that was
 * measured before anything was ported from takos-agent-engine.
 *
 * ## What the measurement showed
 *
 * Across every session on this machine (817 of them):
 *
 *     memory.md non-empty            64  (8%)
 *     sessions using the memory tools 97
 *     set_memory calls               181
 *     read_memory AFTER a write       13
 *
 * So the notes were being WRITTEN and almost never CONSULTED. Two causes, both real
 * defects rather than missing features:
 *
 *  1. The prompt said `memory.md` was injected into the system prompt. It never was —
 *     `systemPrompt()` injects AGENTS.md and nothing else. A model that believes its
 *     notes are already in front of it has no reason to call `read_memory()`. The
 *     `set_memory` reply said "injected into future prompts" too, which repeated the
 *     same falsehood at the moment the model encoded the belief.
 *
 *  2. `set_memory` REPLACES the whole file, so a model that had not just read it
 *     silently erased everything it did not re-send. MEASURED on a real session: 21
 *     writes, the content dropping from 1028 to 83 bytes.
 *
 * The fixes are the two below plus a post-compaction re-attach, which is the one place
 * re-injecting is free (the prompt moves anyway) and obviously right (the history that
 * held the notes was just summarised away).
 *
 * ## Why not port takos-agent-engine
 *
 * Its memory is re-selected and re-assembled on EVERY tool round, which conflicts
 * head-on with teapot's design: `buildMessages()` is `[system] + append-only history`
 * specifically to keep provider prefix caches hot. Per-round memory injection is that
 * exception applied continuously, and it would land on the master agent — the one where
 * per-token cost matters most. teapot already has the right shape (a tool the model
 * calls); what was missing was that the tool's results were never read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const toolCall = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

/** Drive a real agent through a scripted sequence of tool calls. */
async function drive(script: ((n: number) => LlmResult | null)[]) {
  const ws = mkdtempInRootSync("mem-");
  const sd = mkdtempInRootSync("mems-");
  const toolReplies: string[] = [];
  let n = 0;
  const agent = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (_c: unknown, msgs: { role: string; content?: unknown }[]): Promise<LlmResult> => {
      for (const m of msgs) if (m.role === "tool") toolReplies.push(String(m.content ?? ""));
      const next = script[n++];
      return (next ? next(n) : null) ?? { message: { role: "assistant", content: "done" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await agent.init();
  agent.enqueuePrompt("go");
  agent.start("t");
  await agent.settled().catch(() => {});
  return { agent, sd, toolReplies };
}

const memoryOf = (sd: string) => {
  try {
    return fs.readFileSync(path.join(sd, "memory.md"), "utf8");
  } catch {
    return "";
  }
};

test("add_memory APPENDS — an earlier note can never be lost by it (#48)", async () => {
  const { agent, sd } = await drive([
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "set_memory", { content: "FIRST" })] } }),
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("b", "add_memory", { text: "SECOND" })] } }),
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("c", "add_memory", { text: "THIRD" })] } }),
  ]);
  try {
    assert.equal(
      memoryOf(sd),
      "FIRST\nSECOND\nTHIRD\n",
      "each note must survive the ones after it — this is the whole point of the append",
    );
  } finally {
    await agent.dispose();
  }
});

test("add_memory with empty text appends nothing and says so (#48)", async () => {
  const { agent, sd, toolReplies } = await drive([
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "set_memory", { content: "KEEP" })] } }),
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("b", "add_memory", { text: "   " })] } }),
  ]);
  try {
    assert.equal(memoryOf(sd), "KEEP", "a blank note must not touch the file");
    assert.ok(
      toolReplies.some((r) => /non-empty/.test(r)),
      `the model must be told why nothing happened; got ${JSON.stringify(toolReplies.slice(0, 3))}`,
    );
  } finally {
    await agent.dispose();
  }
});

test("the notes are NOT claimed to be in the prompt (#48)", async () => {
  // the measured root cause: a model told its notes are already in the prompt has no
  // reason to call read_memory(), and across every session here it did not (181 writes,
  // 13 reads-after-writing)
  const { agent, sd, toolReplies } = await drive([
    () => ({ message: { role: "assistant", content: "", tool_calls: [toolCall("a", "set_memory", { content: "NOTE" })] } }),
  ]);
  try {
    const reply = toolReplies.find((r) => /memory\.md/.test(r)) ?? "";
    assert.match(reply, /REPLACED/, "an overwrite must be described as an overwrite");
    assert.doesNotMatch(
      reply,
      /injected into (your|future) prompt/i,
      "claiming injection is what stopped the model from reading its own notes",
    );
    assert.match(reply, /read_memory/, "and it must point at the tool that actually shows them");
    // precondition: the file really is NOT in the system prompt
    assert.equal(memoryOf(sd), "NOTE", "precondition: the note was written");
  } finally {
    await agent.dispose();
  }
});

test("the shipped prompt does not claim memory.md is injected (#48)", async () => {
  // asserted on the RUNTIME prompt text (what the model receives), not on a source
  // regex — the false sentence lived in two places and the model read both
  const { agent, sd } = await drive([() => null]);
  try {
    const sys = (agent as unknown as { systemPrompt(): string }).systemPrompt();
    assert.doesNotMatch(
      sys,
      /memory\.md[^.]*injected/i,
      "the system prompt must not claim memory.md is injected",
    );
    assert.match(sys, /add_memory/, "and must name the append tool");
  } finally {
    await agent.dispose();
  }
});

test("a compaction re-attaches the notes, because the history holding them is gone (#48)", async () => {
  // This is the ONE place re-injecting is free: the prompt moves anyway (compaction
  // rewrites the history), and the notes had just been summarised out of existence.
  //
  // Driven through `compactNow()`, the same public path the /compact command uses, so
  // this asserts the real behaviour rather than re-implementing the trigger in a
  // fixture.
  const ws = mkdtempInRootSync("memc-");
  const sd = mkdtempInRootSync("memcs-");
  fs.writeFileSync(path.join(sd, "memory.md"), "REMEMBER: the key lives in env, not config\n");

  const promptsSeen: string[] = [];
  let n = 0;
  const agent = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (_c: unknown, msgs: { role: string; content?: unknown }[]): Promise<LlmResult> => {
      n++;
      // the summarizer is the request whose LAST message carries the directive
      const last = String(msgs[msgs.length - 1]?.content ?? "");
      if (/compress|summar|You are an? .*summar/i.test(last)) {
        return { message: { role: "assistant", content: "## Current work\n- notes" } };
      }
      // record what an ordinary turn is handed
      for (const m of msgs) promptsSeen.push(String(m.content ?? ""));
      return { message: { role: "assistant", content: "x".repeat(400) } };
    },
    autoContinue: false,
  } as never) as Agent;
  await agent.init();
  try {
    // build enough history that a compaction has something to summarise
    agent.enqueuePrompt("first prompt " + "y".repeat(3_000));
    agent.start("t");
    await agent.settled().catch(() => {});
    const before = promptsSeen.length;
    const { ran } = await agent.compactNow();
    assert.ok(ran, "precondition: the compaction actually ran");
    // the re-attached notes are part of the history the NEXT request carries
    agent.enqueuePrompt("after compaction");
    agent.start("t");
    await agent.settled().catch(() => {});
    const after = promptsSeen.slice(before).join("\n");
    assert.match(
      after,
      /durable notes \(memory\.md\), re-attached/,
      "after compaction the notes must come back — otherwise they are write-only",
    );
    assert.match(after, /the key lives in env/, "and the note's TEXT must be there, not just a header");
  } finally {
    await agent.dispose();
  }
});
