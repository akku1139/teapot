import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { EventLog } from "../src/log/events.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

async function appWithLog(dataDir: string, ws: string) {
  const m = new Master(
    { port: 0, dataDir, llm: LLM, providers: {}, agents: [] },
    `${dataDir}/config.json`,
  );
  const app = buildApp(m);
  const agent = await m.addAgent({ id: "a1", workspace: ws }, { persist: true });
  return { app, log: agent.log };
}

async function append(log: EventLog, n: number, from: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const e = await log.append("message", "s", "br0", { role: "assistant", content: `m${from + i}` });
    ids.push(e.id);
  }
  return ids;
}

test("?after= returns only what landed after that event (#54)", async () => {
  await useTempDirs(["t54a-", "t54w-"], async ([dataDir, ws]) => {  const { app, log } = await appWithLog(dataDir!, ws!);
  const first = await append(log, 1, 0);
  await append(log, 5, 1);
  const cursor = first[0]!;

  const r = await app.request(`/api/agents/a1/events?after=${encodeURIComponent(cursor)}`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { events: { id: string }[]; appended?: boolean };

  assert.equal(body.events.length, 5, `only the 5 after the cursor (#54); got ${body.events.length}`);
  assert.ok(
    !body.events.some((e) => e.id === cursor),
    "the cursor event itself must not be repeated (#54)",
  );
  assert.equal(body.appended, true, "and the route says there was a gap to fill (#54)");
  });

});
test("?after= with the newest id returns nothing (#54)", async () => {
  await useTempDirs(["t54a-", "t54w-"], async ([dataDir, ws]) => {  const { app, log } = await appWithLog(dataDir!, ws!);
  const all = await append(log, 3, 0);
  const r = await app.request(`/api/agents/a1/events?after=${encodeURIComponent(all.at(-1)!)}`);
  const body = (await r.json()) as { events: unknown[]; appended?: boolean };
  assert.deepEqual(body.events, [], "already current — no events (#54)");
  assert.equal(body.appended, false, "and the route says so (#54)");
  });

});
test("an unknown cursor is a GAP, not an empty result (#54)", async () => {
  await useTempDirs(["t54a-", "t54w-"], async ([dataDir, ws]) => {  
  const { app, log } = await appWithLog(dataDir!, ws!);
  await append(log, 4, 0);
  const r = await app.request(`/api/agents/a1/events?after=no-such-event-id`);
  const body = (await r.json()) as { events: unknown[]; gap?: boolean };
  assert.equal(body.gap, true, "the client must be told its cursor is stale (#54)");
  assert.equal(body.events.length, 4, "and given the full tail to replace with (#54)");
  });

});
test("recovery scales with the gap, not the log (#54)", async () => {
  await useTempDirs(["t54a-", "t54w-"], async ([dataDir, ws]) => {  
  const { app, log } = await appWithLog(dataDir!, ws!);
  await append(log, 300, 0);           
  const all = await append(log, 1, 300); 
  const two = await append(log, 2, 301);

  const r = await app.request(`/api/agents/a1/events?after=${encodeURIComponent(all[0]!)}`);
  const body = (await r.json()) as { events: { id: string }[] };
  assert.equal(body.events.length, 2, "a 2-event gap transfers 2 events (#54)");
  assert.deepEqual(
    body.events.map((e) => e.id),
    two,
    "and they are the right two, in order (#54)",
  );
  });

});
test("the plain tail request still works (#54)", async () => {
  await useTempDirs(["t54a-", "t54w-"], async ([dataDir, ws]) => {  
  const { app, log } = await appWithLog(dataDir!, ws!);
  await append(log, 6, 0);
  const r = await app.request("/api/agents/a1/events");
  const body = (await r.json()) as { events: unknown[]; total: number };
  assert.equal(body.events.length, 6, "the default request is unchanged (#54)");
  assert.equal(body.total, 6);
  });

});
test("?before= still pages backwards (#54)", async () => {
  await useTempDirs(["t54a-", "t54w-"], async ([dataDir, ws]) => {  
  const { app, log } = await appWithLog(dataDir!, ws!);
  const all = await append(log, 6, 0);
  const r = await app.request(`/api/agents/a1/events?before=${encodeURIComponent(all[3]!)}`);
  const body = (await r.json()) as { events: { id: string }[] };
  assert.equal(body.events.length, 3, "everything strictly before the cursor (#54)");
  });

});
