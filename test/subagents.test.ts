import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import { executeTool, type ToolContext } from "../src/agent/tools.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function mkMaster(dataDir: string): Master {
  return new Master(
    {
      port: 0,
      dataDir,
      llm: LLM,
      providers: {},
      agents: [],
    },
    "/dev/null",
  );
}

async function tmpWs(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sub-ws-"));
}

/** dispose every agent the master owns — kills pending LLM/timer handles */
async function disposeAll(m: Master): Promise<void> {
  await Promise.allSettled([...m.agents.values()].map((a) => a.dispose()));
}

test("spawn depth is capped by config.maxSpawnDepth", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "depth-root-"));
  const m = mkMaster(dataDir);
  (m as unknown as { config: { maxSpawnDepth: number } }).config.maxSpawnDepth = 1;

  const ws = await tmpWs();
  const parent = await m.addAgent({ id: "root", workspace: ws });
  // depth 0 < max 1 → spawning a child is allowed
  const { id } = await (
    m as unknown as { spawnChildFor(a: unknown, o: unknown): Promise<{ id: string }> }
  ).spawnChildFor(parent, { task: "child task", context: "none" });
  assert.match(id, /^root-sub/);

  // child sits at depth 1 == max → its spawn hooks must be absent entirely
  const child = m.agents.get(id)!;
  const ctx = (child as unknown as { toolCtx: { subAgents?: unknown } }).toolCtx;
  assert.equal(ctx.subAgents, undefined, "depth-capped agents must not get spawn hooks");

  // stopping the parent tears down the whole subtree
  const r = await m.stopChildrenFor("root");
  assert.deepEqual(r.stopped, [id]);
  await disposeAll(m);
});

test("read-only personas refuse mutating tools", async () => {
  const ctx: ToolContext = {
    cwd: await tmpWs(),
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 10_000,
    readOnly: true,
  };
  for (const tool of ["write_file", "edit_file", "apply_patch", "bash"]) {
    const args =
      tool === "apply_patch"
        ? { patch: "*** Begin Patch\n*** End Patch" }
        : { path: "x.txt", command: "echo hi", old_text: "a", new_text: "b" };
    const r = await executeTool(tool, JSON.stringify(args), ctx);
    assert.equal(r.ok, false, `${tool} must be blocked`);
    assert.match(r.result, /read-only/);
  }
  // reads still work
  const r = await executeTool("list_dir", JSON.stringify({ path: "." }), ctx);
  assert.equal(r.ok, true);
});

test("PUT /api/config rejects malformed patches with actionable errors", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cfg-root-"));
  const app = buildApp(mkMaster(dataDir));
  const res = await app.request("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providers: { "": { baseUrl: "not-a-url" } },
      progressIntervalMs: 5,
      tasks: [{ id: "", agent: "", schedule: "x", prompt: "" }],
    }),
  });
  assert.equal(res.status, 400);
  const j = (await res.json()) as { error: string };
  assert.match(j.error, /provider name required|progress interval|schedule required/);

  // a valid patch passes
  const ok = await app.request("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ maxSpawnDepth: 2, progressIntervalMs: 60_000 }),
  });
  assert.equal(ok.status, 200);
});

test("waitChildren returns as soon as ALL listed children settle — not at timeout", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "wait-root-"));
  const ws = await tmpWs();
  const m = mkMaster(dataDir);
  const parent = await m.addAgent({ id: "p", workspace: ws });

  const spawn = m as unknown as {
    spawnChildFor(a: unknown, o: unknown): Promise<{ id: string }>;
  };
  const a = await (await spawn.spawnChildFor(parent, { task: "task a", context: "none" })).id;
  const b = await (await spawn.spawnChildFor(parent, { task: "task b", context: "none" })).id;

  // both are spawned running; wait with a generous timeout
  const wait = m.waitChildren("p", undefined, 60_000);
  await new Promise((r) => setTimeout(r, 50)); // let the waiter register

  // settle child A → must NOT resolve yet (b still runs)
  await m.agents.get(a)!.stop("test");
  let settled = false;
  void wait.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(settled, false, "must stay parked while any target is still active");

  // settle the last one → resolves immediately, well before the timeout
  await m.agents.get(b)!.stop("test");
  const r = await Promise.race([
    wait,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("did not wake on final settle")), 2_000)),
  ]);
  assert.match(r.note, /all sub-agents settled/);

  // once everything is settled already, a new wait returns synchronously
  const again = await m.waitChildren("p", undefined, 60_000);
  assert.match(again.note, /already settled/);

  await disposeAll(m);
});
