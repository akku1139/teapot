import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventLog, readEvents, readEventsTail } from "../src/log/events.ts";
import { useTempDirs } from "./helpers/tmp.ts";

test("readEventsTail returns exactly the last N events, in order", async () => {
  await useTempDirs(["t59a-"], async ([dir]) => {
    const f = path.join(dir, "chat.jsonl");
    const log = new EventLog(f, "a");
    await log.load();
    for (let i = 1; i <= 500; i++) await log.append("message", "s", "br0", { i });
    await log.close();

    const got = await readEventsTail(f, 50);
    assert.equal(got.events.length, 50, "must return the tail, not the whole file (#59)");
    assert.equal(got.events.at(-1)!.seq, 500, "newest last (#59)");
    assert.equal(got.events[0]!.seq, 451, "exactly the last 50 (#59)");
    assert.ok(
      got.total >= got.events.length && got.total <= 500,
      `total must be a within-file count, not a guess: got ${got.total} (#59)`,
    );
    assert.equal(got.truncated, true, "the read was partial, and must say so (#59)");
  });
});

test("an UNTRUNCATED log reports truncated=false", async () => {
  await useTempDirs(["t59a2-"], async ([dir]) => {
    const f = path.join(dir, "chat.jsonl");
    const log = new EventLog(f, "a");
    await log.load();
    for (let i = 1; i <= 5; i++) await log.append("message", "s", "br0", { i });
    await log.close();
    const got = await readEventsTail(f, 100);
    assert.equal(got.events.length, 5);
    assert.equal(got.total, 5, "nothing was skipped, so the count is exact (#59)");
    assert.equal(got.truncated, false, "the whole file was read (#59)");
  });
});

test("the tail read must scan FAR less than the whole file (#59)", async () => {
  await useTempDirs(["t59b-"], async ([dir]) => {
    const f = path.join(dir, "chat.jsonl");
    const log = new EventLog(f, "a");
    await log.load();
    for (let i = 1; i <= 4000; i++) await log.append("message", "s", "br0", { i, pad: "y".repeat(60) });
    await log.close();
    const { size } = await (await import("node:fs/promises")).stat(f);

    const got = await readEventsTail(f, 100);
    assert.ok(
      got.bytesScanned * 4 < size,
      `tail read scanned ${got.bytesScanned} of ${size} bytes — it must not read the whole file (#59)`,
    );
  });
});

test("a tail read matches a full read for the same events (#59)", async () => {
  await useTempDirs(["t59c-"], async ([dir]) => {
    const f = path.join(dir, "chat.jsonl");
    const log = new EventLog(f, "a");
    await log.load();
    for (let i = 1; i <= 300; i++) await log.append("message", "s", "br0", { i });
    await log.close();

    const all = await readEvents(f);
    const tail = await readEventsTail(f, 100);
    assert.deepEqual(
      tail.events.map((e) => e.id),
      all.slice(-100).map((e) => e.id),
      "the tail must be identical to the last 100 of a full read (#59)",
    );
  });
});

test("a single event file still reads back", async () => {
  await useTempDirs(["t59d-"], async ([dir]) => {
    const f = path.join(dir, "chat.jsonl");
    const log = new EventLog(f, "a");
    await log.load();
    await log.append("message", "s", "br0", { only: true });
    await log.close();
    const got = await readEventsTail(f, 2000);
    assert.equal(got.events.length, 1, "a one-event log must still be readable (#59)");
    assert.equal(got.total, 1);
  });
});

test("an empty or missing log reads as empty, not a throw (#59)", async () => {
  await useTempDirs(["t59e-"], async ([dir]) => {
    assert.deepEqual((await readEventsTail(path.join(dir, "nope.jsonl"), 10)).events, [], "missing file (#59)");
    const f = path.join(dir, "empty.jsonl");
    await (await import("node:fs/promises")).writeFile(f, "");
    assert.deepEqual((await readEventsTail(f, 10)).events, [], "empty file (#59)");
  });
});

test("a torn final line is skipped, not fatal (#59)", async () => {
  await useTempDirs(["t59f-"], async ([dir]) => {
    const f = path.join(dir, "chat.jsonl");
    const log = new EventLog(f, "a");
    await log.load();
    for (let i = 1; i <= 5; i++) await log.append("message", "s", "br0", { i });
    await log.close();
    await (await import("node:fs/promises")).appendFile(f, '{"v":1,"id":"e6","seq":6,');

    const got = await readEventsTail(f, 10);
    assert.equal(got.events.length, 5, "the torn line is dropped, the intact ones survive (#59)");
    assert.equal(got.events.at(-1)!.seq, 5);
  });
});

test("a torn line is skipped even when it lands INSIDE the read window (#59)", async () => {
  await useTempDirs(["t59g-"], async ([dir]) => {
    const f = path.join(dir, "chat.jsonl");
    const log = new EventLog(f, "a");
    await log.load();
    for (let i = 1; i <= 300; i++) await log.append("message", "s", "br0", { i, pad: "z".repeat(40) });
    await log.close();
    await (await import("node:fs/promises")).appendFile(f, '{"v":1,"id":"eX"');

    const got = await readEventsTail(f, 40);
    assert.ok(got.events.length > 0, "the window still yields events (#59)");
    assert.ok(
      got.events.every((e) => typeof e.seq === "number"),
      "no fragment may be returned as an event (#59)",
    );
  });
});

import { Master, type TeapotConfig } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("POSIX filesystem paths");

function mkMaster(dataDir: string): Master {
  return new Master(
    {
      port: 0, dataDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } },
      defaultProvider: "p", agents: [],
    } as unknown as TeapotConfig,
    "/dev/null",
  );
}

test("the endpoint returns the newest events, and pagination still works (#59)", async () => {
  await useTempDirs(["t59h-", "t59i-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const agent = await m.addAgent({ id: "a1", workspace: ws, provider: "p" }, { persist: false });
    const sess = agent.snapshot().session;
    for (let i = 1; i <= 300; i++)
      await agent.log.append("message", sess, agent.snapshot().branch, { i });
    const app = buildApp(m);

    const latest = await (await app.request("/api/agents/a1/events?limit=50")).json() as any;
    assert.equal(latest.events.length, 50, "the tail is served (#59)");
    assert.equal(latest.events.at(-1).data.i, 300, "newest event present (#59)");
    assert.equal(latest.events[0].data.i, 251, "the LAST 50, not the first (#59)");
    assert.equal(latest.partial, false, "a small log is read whole, so the count is exact (#59)");

    const older = await (
      await app.request(`/api/agents/a1/events?limit=50&before=${latest.events[0].id}`)
    ).json() as any;
    assert.ok(older.events.length > 0, "older page must not be empty (#59)");
    assert.ok(
      older.events.every((e: any) => e.data.i < 251),
      "every event on the older page must predate the cursor (#59)",
    );
    assert.equal(older.events.at(-1).data.i, 250, "the page must END at the cursor (#59)");

    const lastOfOlder = older.events.at(-1).data.i;
    const firstOfLatest = latest.events[0].data.i;
    assert.equal(firstOfLatest - lastOfOlder, 1, "no gap or overlap between pages (#59)");
    await m.stopAllAgents(2000);
  });
});

test("branch filtering still needs the full log and still works (#59)", async () => {
  await useTempDirs(["t59j-", "t59k-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const agent = await m.addAgent({ id: "a1", workspace: ws, provider: "p" }, { persist: false });
    const sess = agent.snapshot().session;
    const other = `br-other`;
    for (let i = 1; i <= 60; i++)
      await agent.log.append("message", sess, agent.snapshot().branch, { i, on: "main" });
    for (let i = 61; i <= 80; i++) await agent.log.append("message", sess, other, { i, on: other });
    const app = buildApp(m);

    const r = await (await app.request(`/api/agents/a1/events?branch=${other}`)).json() as any;
    assert.equal(r.events.length, 20, "only that branch's events (#59)");
    assert.ok(r.events.every((e: any) => e.data.on === other), "no leakage across branches (#59)");
    await m.stopAllAgents(2000);
  });
});

test("a log larger than the tail floor reports partial=true (#59)", async () => {
  await useTempDirs(["t59l-", "t59m-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const agent = await m.addAgent({ id: "a1", workspace: ws, provider: "p" }, { persist: false });
    const sess = agent.snapshot().session;
    for (let i = 1; i <= 1200; i++)
      await agent.log.append("message", sess, agent.snapshot().branch, { i, pad: "q".repeat(200) });
    const app = buildApp(m);
    const r = await (await app.request("/api/agents/a1/events?limit=20")).json() as any;
    assert.equal(r.events.length, 20);
    assert.equal(r.events[0].data.i, 1181, "the last 20 of 1200 (#59)");
    assert.equal(r.partial, true, "a big log is read partially, and says so (#59)");
    assert.ok(r.total < 1200, "total is a LOWER BOUND here, not the true count (#59)");
    await m.stopAllAgents(2000);
  });
});
