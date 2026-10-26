import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { EventLog, readEvents } from "../src/log/events.ts";

function fdsFor(file: string): number {
  try {
    return readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return readlinkSync(`/proc/self/fd/${fd}`) === file;
      } catch {
        return false;
      }
    }).length;
  } catch {
    return -1; 
  }
}

async function waitForFds(file: string, want = 0, deadlineMs = 2_000): Promise<number> {
  const start = Date.now();
  for (;;) {
    const n = fdsFor(file);
    if (n === want || Date.now() - start > deadlineMs) return n;
    await new Promise((r) => setTimeout(r, 10));
  }
}

const hasProc = fdsFor("/dev/null") !== -1;

test("loading a log does NOT hold a descriptor open (#143)", { skip: !hasProc }, async () => {
  await useTempDir("logfd-", async (dir) => {
    const file = path.join(dir, "chat.jsonl");
    const log = new EventLog(file, "a");
    await log.load();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fdsFor(file), 0, "load() must not keep the append stream open (#143)");
    await log.close();
  });
});

test("an idle log releases its descriptor, and a later append reopens it (#143)", { skip: !hasProc }, async () => {
  await useTempDir("logfd-", async (dir) => {
    const file = path.join(dir, "chat.jsonl");
    const log = new EventLog(file, "a");
    await log.load();
    await log.append("prompt", "s1", "br0", { source: "user", text: "hi" });
    assert.equal(await waitForFds(file, 1, 500), 1, "an append must open exactly one stream (#143)");

    await (log as unknown as { fireIdleClose(): void }).fireIdleClose();
    assert.equal(await waitForFds(file), 0, "an idle log must give the descriptor back (#143)");

    await log.append("message", "s1", "br0", { role: "assistant", content: "again" });
    const events = await readEvents(file);
    assert.deepEqual(
      events.map((e) => e.type),
      ["prompt", "message"],
      "reopening must APPEND, not truncate or drop (#143)",
    );
    await log.close();
  });
});

test("a closed log still drops loudly rather than reopening (#143)", { skip: !hasProc }, async () => {
  await useTempDir("logfd-", async (dir) => {
    const file = path.join(dir, "chat.jsonl");
    const log = new EventLog(file, "a");
    await log.load();
    await log.append("prompt", "s1", "br0", { source: "user", text: "before" });
    await log.close();
    assert.equal(await waitForFds(file), 0, "close() must release the descriptor (#143)");

    await log.append("prompt", "s1", "br0", { source: "user", text: "after" });
    const events = await readEvents(file);
    assert.deepEqual(
      events.map((e) => (e.data as { text?: string }).text),
      ["before"],
      "a post-close append must NOT be written (#143)",
    );
    assert.equal(await waitForFds(file), 0, "and must not reopen the stream either (#143)");
  });
});
