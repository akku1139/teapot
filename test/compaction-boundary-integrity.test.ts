/**
 * A HALF-WRITTEN compaction boundary must not delete history.
 *
 * ZCode's invariant, stated for its own boundary record: a summary message, its text
 * part and its compaction part are ONE logical write, and "compact 失败不会写入半截
 * boundary" — a failure must not leave a half state, and a damaged preserved segment
 * falls back conservatively with a warning rather than acting on it.
 *
 * The teapot equivalent is a `compaction` event whose `mode` says "summarize" but which
 * carries no summary text. Applying it replaces the leading messages with a note saying
 * "(summary unavailable)" — deleting history to put nothing in its place. That is the
 * worst failure compaction can have, because the discarded prefix holds the original
 * request and the summary is meant to be its only remaining record.
 *
 * Reaching the state needs a hand-edited or truncated log: the live path only writes
 * `mode: "summarize"` when it HAS a summary. So the guard is for a damaged file, which
 * is exactly when silently discarding history would be least recoverable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { EventLog } from "../src/log/events.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const ORIGINAL = "IMPORTANT-ORIGINAL-REQUEST-xyz";

/** write a log whose final event is a damaged compaction boundary */
async function damagedLog(file: string, data: Record<string, unknown>): Promise<void> {
  const log = new EventLog(file, "a");
  await log.load();
  await log.append("prompt", "s", "br0", { source: "user", text: ORIGINAL });
  await log.append("message", "s", "br0", { role: "assistant", content: "working on it" });
  await log.append("message", "s", "br0", { role: "assistant", content: "more work" });
  await log.append("compaction", "s", "br0", data);
  await log.close();
}

async function restoredText(data: Record<string, unknown>): Promise<string> {
  const dir = mkdtempInRootSync("hb-");
  const file = path.join(dir, "chat.jsonl");
  await damagedLog(file, data);
  // drive the REAL restore path through the log reader + agent rebuild
  const { Agent } = await import("../src/agent/agent.ts");
  const a = new Agent({
    id: "t",
    workspace: mkdtempInRootSync("hbw-"),
    sessionDir: dir,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
    autoContinue: false,
    restoreSession: true,
  } as never);
  await a.init();
  try {
    await (a as unknown as { ensureReady(): Promise<void> }).ensureReady();
    return a.conversation.map((m: { content?: string | null }) => m.content ?? "").join("\n");
  } finally {
    await a.dispose();
  }
}

test("a summarize boundary with NO summary text keeps the history (#150, ZCode)", async () => {
  const text = await restoredText({
    tokensBefore: 100,
    tokensAfter: 10,
    summarized: 3,
    dropped: 0,
    mode: "summarize",
    // no `summary` field: the half-written state
  });
  assert.match(
    text,
    new RegExp(ORIGINAL),
    "the original request must SURVIVE — replacing it with a note would lose the one thing compaction cannot recover",
  );
  assert.doesNotMatch(text, /summary unavailable/, "and the placeholder must not be the record of record");
});

test("a well-formed summarize boundary is still applied (#150)", async () => {
  // the non-regression half: the guard must not disable normal compaction
  const text = await restoredText({
    tokensBefore: 100,
    tokensAfter: 10,
    summarized: 3,
    dropped: 0,
    mode: "summarize",
    summary: "## Primary request and intent\n- do the thing",
  });
  assert.match(text, /Context was compacted/, "a valid boundary is applied");
  assert.match(text, /do the thing/, "and its summary becomes the head");
  assert.doesNotMatch(text, new RegExp(ORIGINAL), "the summarized prefix is replaced, as designed");
});

test("a truncate boundary still drops exactly what it recorded (#150)", async () => {
  const text = await restoredText({ tokensBefore: 100, tokensAfter: 10, summarized: 0, dropped: 2, mode: "truncate" });
  assert.doesNotMatch(text, new RegExp(ORIGINAL), "the dropped prefix is gone");
  assert.match(text, /more work/, "and the kept tail remains");
});
