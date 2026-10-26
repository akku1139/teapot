import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("POSIX filesystem paths");

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function mkMaster(dataDir: string): Master {
  return new Master(
    { port: 0, dataDir, llm: LLM, providers: {}, agents: [] },
    "/dev/null",
  );
}

const post = (app: any, url: string, body?: unknown) =>
  app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("POST /api/agents defaults to NOT starting the loop (first prompt starts it)", async () => {
  await useTempDirs(["webstart-root-", "ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const app = buildApp(m);

    const r1 = await post(app, "/api/agents", { workspace: ws, id: "lazy" });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).agent.status, "stopped");
    assert.equal(m.agents.get("lazy")!.status, "stopped");

    const r2 = await post(app, "/api/agents", { workspace: ws, id: "lazy2", start: false });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).agent.status, "stopped");

    for (const a of m.agents.values()) await a.dispose();
  });
});

test("prompting a freshly created agent moves it out of 'stopped'", async () => {
  await useTempDirs(["webstart-prompt-", "ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const app = buildApp(m);

    const r = await post(app, "/api/agents", { workspace: ws, id: "p", start: false });
    assert.equal(r.status, 200);
    assert.equal(m.agents.get("p")!.status, "stopped");

    const pr = await post(app, "/api/agents/p/prompt", { text: "hello", start: false });
    assert.equal(pr.status, 200);
    await waitFor(async () =>
      ((await (await app.request("/api/agents/p/events")).json()).events ?? []).some(
        (e: any) => e.type === "prompt" && e.data?.text === "hello",
      ),
    );
    await m.agents.get("p")!.dispose();
  });
});

test("a fresh incarnation gets its own empty timeline, not the old one's", async () => {
  await useTempDirs(["fresh-timeline-", "ws-"], async ([dataDir, ws]) => {
    const m = mkMaster(dataDir);
    const app = buildApp(m);

    const r1 = await post(app, "/api/agents", { workspace: ws, id: "proj", start: false });
    assert.equal(r1.status, 200);
    await post(app, "/api/agents/proj/prompt", { text: "hello from incarnation one", start: false });
    await waitFor(async () =>
      ((await (await app.request("/api/agents/proj/events")).json()).events ?? []).length > 0,
    );
    const firstSession = m.agents.get("proj")!.snapshot().session;

    const dr = await app.request("/api/agents/proj", { method: "DELETE" });
    assert.equal(dr.status, 200);
    const r2 = await post(app, "/api/agents", { workspace: ws, id: "proj", start: false });
    assert.equal(r2.status, 200);
    const second = m.agents.get("proj")!;
    const secondSession = second.snapshot().session;

    assert.notEqual(secondSession, firstSession);
    const ev2 = await (await app.request("/api/agents/proj/events")).json();
    assert.deepEqual(ev2.events, []); 

    await post(app, "/api/agents/proj/prompt", { text: "hello again", start: false });
    await waitFor(async () =>
      ((await (await app.request("/api/agents/proj/events")).json()).events ?? []).some(
        (e: any) => e.type === "prompt" && e.data?.text === "hello again",
      ),
    );
    const newFile = path.join(dataDir, "sessions", secondSession, "chat.jsonl");
    await waitFor(async () => (await readFile(newFile, "utf8").catch(() => "")).includes("hello again"));
    const raw = await readFile(
      newFile,
      "utf8",
    );
    const allFiles: Record<string, string> = {};
    for (const d of await readdir(path.join(dataDir, "sessions"))) {
      allFiles[d] = await readFile(path.join(dataDir, "sessions", d, "chat.jsonl"), "utf8").catch((e) => e.message);
    }
    assert.ok(
      raw.includes("hello again"),
      `new session file misses the new prompt\nsecondSession=${secondSession} logFile=${second.log.filePath}\nRAW=${JSON.stringify(raw).slice(0, 600)}\nsessions=${JSON.stringify(Object.keys(allFiles))}\ncontents=${JSON.stringify(allFiles).slice(0, 1500)}`,
    );
    assert.ok(!raw.includes("hello from incarnation one"));
    await second.dispose();
  });
});
