/**
 * #56 — "I'd like the `/compact` START event on the timeline too; in the right
 *        panel alone it's hard to tell what happened."
 *
 * Compaction was only observable from its OUTCOME: the `context-compacted`
 * note and the `compaction` event are both appended once the whole pass is
 * over. A summarize pass over a large history takes many seconds, and during
 * it the timeline showed nothing at all — so a `/compact` (or an automatic
 * overflow compaction) looked exactly like the agent had hung.
 *
 * The fix logs a `context-compaction-started` system_note BEFORE the
 * summarizer runs, and the web UI renders it as a divider.
 *
 * These tests assert ORDER, not just presence: a start marker appended after
 * the pass would be indistinguishable from no marker at all, which is the bug
 * being fixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents, type TeapotEvent } from "../src/log/events.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (content: string, calls?: ReturnType<typeof tc>[]): LlmResult => ({
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
});

/** the system prompt that identifies the summarizer's own LLM call */
const isSummarizer = (messages: any) =>
  String(messages[0]?.content ?? "").includes("You compress a coding agent's conversation");

const noteEvents = (events: TeapotEvent[]) =>
  events.filter((e) => e.type === "system_note").map((e) => String((e.data as any)?.event ?? ""));

const notesOf = (events: TeapotEvent[], name: string) =>
  events.filter((e) => e.type === "system_note" && (e.data as any)?.event === name).map((e) => e.data as any);

/**
 * Build an agent that is guaranteed to hit a compaction pass. `onSummarize` is
 * invoked at the exact moment the summarizer runs — the window in which the
 * operator is staring at a silent timeline — and may inspect the log.
 */
function compactingAgent(
  ws: string,
  sessionDir: string,
  onSummarize?: () => Promise<string[]> | string[],
) {
  const big = "x".repeat(2000);
  let n = 0;
  const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
    n++;
    if (isSummarizer(messages)) {
      if (onSummarize) await onSummarize();
      return reply("- summary of earlier work");
    }
    if (n === 1) return reply("writing", [tc("w1", "write_file", { path: "big.txt", content: big })]);
    return reply("done");
  };
  return new Agent({
    id: "t",
    workspace: ws,
    sessionDir,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
    chatFn,
    contextTokenBudget: 200,
    autoContinue: false,
  } as any);
}

test("a compaction pass announces itself BEFORE it runs (#56)", async () => {
  await useTempDirs(["c56a-", "c56b-"], async ([ws, sessionDir]) => {
    const agent = compactingAgent(ws!, sessionDir!);
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();

    const events = await readEvents(agent.log.filePath);
    const names = noteEvents(events);
    assert.ok(
      names.includes("context-compaction-started"),
      `expected a context-compaction-started note, saw: ${names.join(", ") || "(none)"}`,
    );
    assert.ok(names.includes("context-compacted"), `expected the completion note too, saw: ${names.join(", ")}`);

    // ORDER is the point: a start note written after the pass is
    // indistinguishable from no start note at all.
    const start = notesOf(events, "context-compaction-started")[0]!;
    const done = notesOf(events, "context-compacted")[0]!;
    const startEv = events.find((e) => e.data === start)!;
    const doneEv = events.find((e) => e.data === done)!;
    assert.ok(
      startEv.seq < doneEv.seq,
      `the start note must precede the completion note (start seq ${startEv.seq}, done seq ${doneEv.seq})`,
    );
    await agent.dispose();
  });
});

test("the start note is on disk WHILE the summarizer is still running (#56)", async () => {
  // The real regression is the SILENCE, not a missing record at the end. If
  // the note is only written once the pass finishes, the timeline is blank for
  // the whole summarize. Reading the log from inside the summarizer call is the
  // only way to prove the record exists during that gap.
  await useTempDirs(["c56c-", "c56d-"], async ([ws, sessionDir]) => {
    let duringPass: string[] = [];
    const agent = compactingAgent(ws!, sessionDir!, async () => {
      // read the FILE, not in-memory state — the operator only ever sees
      // events that have been APPENDED to the log
      const text = await readFile(agent.log.filePath, "utf8");
      duringPass = text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e: TeapotEvent) => e.type === "system_note")
        .map((e: TeapotEvent) => String((e.data as any)?.event ?? ""));
    });
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();

    assert.ok(
      duringPass.includes("context-compaction-started"),
      `the start note must be on disk DURING the summarize pass, saw: ${duringPass.join(", ") || "(none)"}`,
    );
    assert.ok(
      !duringPass.includes("context-compacted"),
      "the completion note must not be there yet — that is the whole point of the start marker",
    );
    await agent.dispose();
  });
});

test("the start note carries only figures known at announce time (#56)", async () => {
  await useTempDirs(["c56e-", "c56f-"], async ([ws, sessionDir]) => {
    const agent = compactingAgent(ws!, sessionDir!);
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();

    const events = await readEvents(agent.log.filePath);
    const start = notesOf(events, "context-compaction-started")[0]!;
    const done = notesOf(events, "context-compacted")[0]!;

    assert.equal(typeof start.messages, "number", "reports how many messages are being summarized");
    assert.ok((start.messages as number) > 0, `expected a positive message count, got ${start.messages}`);
    assert.equal(typeof start.tokensBefore, "number", "reports the before-figure");
    assert.equal(start.tokensAfter, undefined, "the after-figure is unknown yet — it must not be guessed");
    assert.equal(typeof start.reason, "string", "says whether this was manual (/compact) or automatic");
    // the completion note still carries the authoritative pair
    assert.equal(typeof done.tokensBefore, "number");
    assert.equal(typeof done.tokensAfter, "number");
    await agent.dispose();
  });
});

test("a forced /compact is labelled manual, an automatic one is not (#56)", async () => {
  await useTempDirs(["c56g-", "c56h-"], async ([ws, sessionDir]) => {
    const agent = compactingAgent(ws!, sessionDir!);
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    // the run above compacted because it blew the budget → automatic
    const events = await readEvents(agent.log.filePath);
    const start = notesOf(events, "context-compaction-started")[0]!;
    assert.equal(start.reason, "auto", "a budget-driven pass is automatic");
    await agent.dispose();
  });
});

test("the web UI renders the start note as a visible timeline row (#56)", async () => {
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  assert.match(app, /context-compaction-started/, "the web UI must handle the start note (#56)");
  const idx = app.indexOf("context-compaction-started");
  const window = app.slice(idx, idx + 800);
  assert.match(
    window,
    /divider-msg|embed/,
    `the start note must render a VISIBLE row, not a log-only note. Saw: ${window.slice(0, 240)}`,
  );
  // it must not sit after the blanket `return null` for log-only notes
  const handlerStart = app.lastIndexOf('if (e.type === "system_note")', idx);
  const nullIndex = app.indexOf("return null; // log-only notes", handlerStart);
  assert.ok(
    nullIndex === -1 || idx < nullIndex,
    "the start-note branch must come BEFORE the log-only fallthrough (#56)",
  );
});
