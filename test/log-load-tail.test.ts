/**
 * `EventLog.load()` reads only the TAIL now.
 *
 * It used to `readFile()` every log in full and JSON.parse every event, to learn
 * two things that both live at the end of an append-only file:
 *
 *   - the highest `seq` (assigned monotonically, so the last complete line has it)
 *   - the last event id per branch (`lastEventId()` is only ever called for the
 *     CURRENT branch — fork and child-spawn — which is the most recent one)
 *
 * MEASURED over the real 813-session data dir (377 MB of logs): `load()` went
 * from 2225 ms to 878 ms, and it no longer materialises one whole log as a
 * string plus its `split` array.
 *
 * The risk this must pin is `seq`: if the tail read ever under-reports it, the
 * next append reuses an id that already exists, and `mergeEvents` on the client
 * DEDUPES BY ID — two distinct events would collapse into one row. So the
 * assertions below are about exactness, not speed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { EventLog, readEvents } from "../src/log/events.ts";

/** a log with `n` well-formed events, returned as its JSONL text */
function logText(n: number, agent = "a", branch = "br0"): string {
  const lines: string[] = [];
  let parent: string | null = null;
  for (let i = 1; i <= n; i++) {
    const id = `e${i}`;
    lines.push(
      JSON.stringify({
        v: 1, id, seq: i, ts: "2026-01-01T10:00:00.000Z", agent, session: "s", branch,
        parent, type: "message", data: { role: "assistant", content: `event ${i}` },
      }),
    );
    parent = id;
  }
  return lines.join("\n") + "\n";
}

test("seq stays EXACT for a log far larger than the tail window (#143)", async () => {
  await useTempDir("loadtail-", async (dir) => {
    const file = path.join(dir, "chat.jsonl");
    // ~1.2 MB of events: comfortably past the 512 KB tail window, so the load
    // MUST be reading a window and still getting the right answer
    const N = 6000;
    writeFileSync(file, logText(N));
    assert.ok(readFileSync(file).length > 512 * 1024, "precondition: the log exceeds the tail window");

    const log = new EventLog(file, "a");
    await log.load();
    const ev = await log.append("prompt", "s", "br0", { source: "user", text: "after load" });

    assert.equal(ev.seq, N + 1, "the next seq must continue past EVERY existing event (#143)");
    const all = await readEvents(file);
    const ids = all.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "no id may be reused — the client dedupes by id (#143)");
  });
});

test("the current branch's head survives the window, so parent chaining continues (#143)", async () => {
  await useTempDir("loadtail-", async (dir) => {
    const file = path.join(dir, "chat.jsonl");
    const N = 6000;
    writeFileSync(file, logText(N));

    const log = new EventLog(file, "a");
    await log.load();
    assert.equal(log.lastEventId("br0"), `e${N}`, "the newest event on the current branch must be known");

    const ev = await log.append("message", "s", "br0", { role: "assistant", content: "next" });
    assert.equal(ev.parent, `e${N}`, "and it must be used as the parent, or the chain is severed (#143)");
  });
});

test("a small log still loads completely, including older branches (#143)", async () => {
  await useTempDir("loadtail-", async (dir) => {
    const file = path.join(dir, "chat.jsonl");
    // one event on a second branch, then lots on the first — a small file, so the
    // whole thing is read and nothing is dropped
    const side = JSON.stringify({
      v: 1, id: "side1", seq: 1, ts: "2026-01-01T09:00:00.000Z", agent: "a", session: "s",
      branch: "side", parent: null, type: "message", data: {},
    });
    writeFileSync(file, `${side}\n${logText(20)}`);

    const log = new EventLog(file, "a");
    await log.load();
    assert.equal(log.lastEventId("side"), "side1", "a branch inside the window keeps its head (#143)");
    assert.equal(log.lastEventId("br0"), "e20");
  });
});

test("a torn final line does not corrupt the seq (#143)", async () => {
  await useTempDir("loadtail-", async (dir) => {
    const file = path.join(dir, "chat.jsonl");
    const N = 6000;
    writeFileSync(file, logText(N) + '{"v":1,"id":"e6001","seq":6001,"ag');
    const log = new EventLog(file, "a");
    await log.load();
    const ev = await log.append("prompt", "s", "br0", { source: "user", text: "x" });
    assert.ok(ev.seq > N, `a partial tail line must not lose the seq: got ${ev.seq} (#143)`);
  });
});
