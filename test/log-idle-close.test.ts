/**
 * #143 — memory grew with every session the operator created.
 *
 * MEASURED on a real running master (493 agents in config):
 *
 *     open chat.jsonl descriptors: 493
 *     RSS: 295 MB, heapUsed: 111 MB
 *
 * `EventLog.load()` opened the append stream and only `close()` — called from
 * `dispose()` and shutdown — released it. A loaded agent therefore held a file
 * descriptor for the whole process lifetime, and agents are permanent (there is
 * no eviction), so the count only ever went up.
 *
 * The log is append-only, so the stream carries no state that must be kept:
 * reopening with `flags: "a"` continues exactly where the last write stopped.
 * The fix opens on demand and closes after a quiet period, which is what these
 * tests measure — with real files and a real descriptor count, because a
 * helper-level assertion cannot see a descriptor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readlinkSync } from "node:fs";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { EventLog, readEvents } from "../src/log/events.ts";

/** how many descriptors this process holds on the given file */
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
    return -1; // /proc unavailable (non-Linux) — the tests skip below
  }
}

/**
 * Poll until the file's descriptor count reaches `want` (default 0).
 *
 * `stream.end(cb)` fires when the write side is FINISHED, which is not the same
 * moment the OS descriptor is released — so asserting the count synchronously
 * after `close()` is a race, and it flaked under a full parallel run. The
 * assertion still has to hold; it just gets a moment to. A genuine leak never
 * reaches the target, so this cannot hide one.
 */
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
    // `createWriteStream` opens ASYNCHRONOUSLY, so an immediate count can miss a
    // stream that the old code did open — this waited-out tick is what makes the
    // assertion able to fail on the pre-#143 code.
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
    // an OPEN stream is created asynchronously too, so this waits for it rather
    // than assuming it exists the instant append() resolves
    assert.equal(await waitForFds(file, 1, 500), 1, "an append must open exactly one stream (#143)");

    // the idle close is on a 15s timer; fire it directly so the test is fast and
    // does not depend on wall-clock timing (this is the exact path the timer runs)
    await (log as unknown as { fireIdleClose(): void }).fireIdleClose();
    assert.equal(await waitForFds(file), 0, "an idle log must give the descriptor back (#143)");

    // and writing again must work, not drop — the append-only contract
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

    // #143: DISPOSED must stay distinguishable from IDLE. An idle log reopens;
    // a disposed one must not, or shutdown could be undone by a late append.
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
