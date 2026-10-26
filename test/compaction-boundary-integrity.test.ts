import { test } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { EventLog } from "../src/log/events.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const ORIGINAL = "IMPORTANT-ORIGINAL-REQUEST-xyz";

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
  });
  assert.match(
    text,
    new RegExp(ORIGINAL),
    "the original request must SURVIVE — replacing it with a note would lose the one thing compaction cannot recover",
  );
  assert.doesNotMatch(text, /summary unavailable/, "and the placeholder must not be the record of record");
});

test("a well-formed summarize boundary is still applied (#150)", async () => {
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
