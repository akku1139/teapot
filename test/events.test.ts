import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { EventLog, readEvents } from "../src/log/events.ts";

test("events: parent chain + monotonic seq", async () => {
  await useTempDir("teapot-events-", async (dir) => {
    const f = path.join(dir, "log.jsonl");
    const log = new EventLog(f, "a");
    await log.load();
    const e1 = await log.append("prompt", "s", "br0", { text: "hi" });
    const e2 = await log.append("message", "s", "br0", { role: "assistant", content: "yo" });
    await log.close();
    assert.equal(e1.parent, null);
    assert.equal(e2.parent, e1.id);
    assert.equal(e2.seq, e1.seq + 1);

    const events = await readEvents(f);
    assert.equal(events.length, 2);
  });
});

test("events: torn trailing line is ignored and seq resumes after reload", async () => {
  await useTempDir("teapot-events-", async (dir) => {
    const f = path.join(dir, "log.jsonl");
    const log = new EventLog(f, "a");
    await log.load();
    await log.append("prompt", "s", "br0", { text: "one" });
    await log.close();

    await appendFile(f, '{"v":1,"id":"e99","seq":9,"torn');

    const log2 = new EventLog(f, "a");
    await log2.load();
    const e = await log2.append("message", "s", "br0", { role: "assistant", content: "two" });
    assert.equal(e.seq, 2); // torn line's seq=9 must not be trusted
    assert.equal(e.parent, "e1");
    await log2.close();
    // torn line stays unreadable junk (skipped); e1 + repaired-append e2 survive
    assert.equal((await readEvents(f)).length, 2);
  });
});

test("events: branches track independent parents", async () => {
  await useTempDir("teapot-events-", async (dir) => {
    const f = path.join(dir, "log.jsonl");
    const log = new EventLog(f, "a");
    await log.load();
    await log.append("prompt", "s", "br0", {});
    await log.append("fork", "s", "br1", {});
    await log.append("message", "s", "br1", { role: "assistant", content: "on branch" });
    assert.equal(log.lastEventId("br0"), "e1");
    assert.equal(log.lastEventId("br1"), "e3");
    await log.close();
  });
});
