/**
 * Two server-side resource guards found in a full-codebase review. Both are
 * "the limit exists but does not hold", which is worse than having no limit,
 * because the code reads as though it is protected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/server/api.ts";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";

/**
 * Run `fn` against a Master with a real config file and a real temp workspace.
 *
 * #75: both roots come from `useTempDirs`, which removes them in a finally. A
 * bare `mkdtempSync` leaked a directory on EVERY run of this file — which is
 * how /tmp filled up. The roots must stay alive for the whole of `fn`, so this
 * is a scoped callback rather than a constructor returning paths: an earlier
 * version returned them, the `finally` deleted them, and every request then
 * failed with "directory not found".
 */
async function withHarness(
  fn: (h: { master: Master; app: ReturnType<typeof buildApp>; ws: string }) => Promise<void> | void,
): Promise<void> {
  await useTempDirs(["p70-", "w70-"], async ([dataDir, ws]) => {
    const cfgPath = path.join(dataDir!, "config.json");
    const cfg = {
      port: 0,
      dataDir: dataDir!,
      llm: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" },
      providers: { p: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" } },
      defaultProvider: "p",
      agents: [],
    };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const master = new Master(JSON.parse(JSON.stringify(cfg)), cfgPath);
    await fn({ master, app: buildApp(master), ws: ws! });
  });
}

/* ---------- #71: concurrent creates must not collide ---------- */

test("concurrent agent creates get distinct ids (#71)", async () => {
  await withHarness(async ({ master, app, ws }) => {
    const post = () =>
      app.request("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: ws, id: "same", start: false }),
      });
    // app.request returns a Response; await the request, THEN read the body
    const responses = await Promise.all([post(), post(), post(), post(), post()]);
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<any>));
    const ids = bodies.map((b) => b.agent?.id ?? `ERR:${b.error}`);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `every concurrent create must get a distinct id (#71); got ${JSON.stringify(ids)}`,
    );
    await master.stopAllAgents?.(5000);
  });
});

test("the config does not accumulate duplicate entries (#71)", async () => {
  // the data-loss part: each racing create minted its own session dir, and on
  // restart resolveSessionDir binds to the FIRST entry — the rest are orphaned
  await withHarness(async ({ master, app, ws }) => {
    const post = () =>
      app.request("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: ws, id: "dup", start: false }),
      });
    await Promise.all([post(), post(), post()]);
    // The FIRST create legitimately keeps the bare id "dup"; the other two must
    // have been suffixed. What must never happen is two entries sharing one id.
    const withId = (master.config.agents ?? []).filter((a: any) => a.id === "dup");
    assert.ok(
      withId.length <= 1,
      `at most one entry may hold the bare id (#71); got ${withId.length}`,
    );
    assert.equal(
      (master.config.agents ?? []).length,
      new Set((master.config.agents ?? []).map((a: any) => a.id)).size,
      "every persisted id must be unique (#71)",
    );
    await master.stopAllAgents?.(5000);
  });
});

test("a failed create does not leak its reservation (#71)", async () => {
  // a reservation that is never released would make the id permanently
  // un-creatable, which is a worse failure than the race it prevents
  await withHarness(async ({ master, app, ws }) => {
    const bad = () =>
      app.request("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: "/definitely/not/here", id: "leaky", start: false }),
      });
    const r1 = await bad();
    assert.equal(r1.status, 400, "a bad workspace must fail (#71)");
    // now a GOOD create with the same id must still work — i.e. the reservation
    // was released rather than stranded
    const good = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: ws, id: "leaky", start: false }),
    });
    const body = (await good.json()) as any;
    assert.ok(body.ok, `the id must not stay reserved after a failure (#71): ${JSON.stringify(body)}`);
    await master.stopAllAgents?.(5000);
  });
});

/* ---------- #70: the terminal cap must actually cap ---------- */

test("the terminal cap holds (#70)", async () => {
  // Source-level: the guard exists, but a connection refused at the cap used to
  // decrement a counter it never incremented, so repeated connect/close cycles
  // drove the counter to zero while real shells stayed alive — measured 16 live
  // shells against a max of 10.
  //
  // The WebSocket handler needs a live upgrade to exercise end to end, so this
  // pins the two properties that made it drift: admission is tracked per
  // connection, and the release is gated on it.
  const src = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /let admitted = false;/,
    "admission must be tracked per connection (#70)",
  );
  assert.match(
    src,
    /if \(!admitted\) return;[\s\S]{0,120}termCounts\.get\(agentId\) \?\? 1\) - 1/,
    "only an ADMITTED connection may decrement the counter (#70)",
  );
  assert.match(
    src,
    /if \(cur >= 10\)/,
    "the cap itself must still be enforced (#70)",
  );
});
