import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildApp } from "../src/server/api.ts";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";

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

test("concurrent agent creates get distinct ids (#71)", async () => {
  await withHarness(async ({ master, app, ws }) => {
    const post = () =>
      app.request("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: ws, id: "same", start: false }),
      });
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
  await withHarness(async ({ master, app, ws }) => {
    const post = () =>
      app.request("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: ws, id: "dup", start: false }),
      });
    await Promise.all([post(), post(), post()]);
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
  await withHarness(async ({ master, app, ws }) => {
    const bad = () =>
      app.request("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace: "/definitely/not/here", id: "leaky", start: false }),
      });
    const r1 = await bad();
    assert.equal(r1.status, 400, "a bad workspace must fail (#71)");
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

