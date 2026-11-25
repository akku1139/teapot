import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
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

    await appendFile(f, '{"seq":9,"torn' );

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

/**
 * An OLD line needs no migration: it reads correctly, and the derived values win.
 *
 * This is the whole compatibility story for the format change that dropped `v`/`id`/`agent`/`session` from the line
 * (1,000,000 events / 973MB, where those fields cost 99MB). Rewriting existing logs to the new shape would be a disk-IO event
 * measured in gigabytes per session, so the rule is only that nothing WRITES them again and nothing READS them — an old line
 * still carries the keys, they are simply not looked at.
 *
 * Pinned here, next to the format, so no future session concludes a migration is required.
 */
test("an old-format line reads correctly without any migration (#format)", async () => {
  const dir = mkdtempInRootSync("ev-old-");
  const file = path.join(dir, "chat.jsonl");
  await writeFile(
    path.join(dir, "session.json"),
    JSON.stringify({ v: 1, agentId: "real-agent" }),
  );
  // exactly what an older version wrote, including a stored session that does NOT match the directory
  await writeFile(
    file,
    JSON.stringify({
      v: 1,
      id: "e1",
      seq: 1,
      ts: "2026-01-01T00:00:00Z",
      agent: "WRONG-AGENT",
      session: "WRONG-SESSION",
      branch: "br0",
      parent: null,
      type: "message",
      data: { content: "old" },
    }) + "\n",
  );

  const [e] = await readEvents(file);
  assert.ok(e, "the old line is read, not skipped");
  assert.equal(e.seq, 1);
  assert.equal(e.id, "e1", "the id is derived from the sequence");
  assert.equal(e.agent, "real-agent", "the manifest wins over the stored agent");
  assert.equal(e.session, path.basename(dir), "the directory wins over the stored session");
  assert.equal((e.data as { content: string }).content, "old", "and the payload is untouched");

  // and the dropped fields do not ride along into the event every caller sees
  assert.ok(!Object.hasOwn(e, "v"), "an old `v` must not leak onto the event");
});
