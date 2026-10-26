import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { executeTool } from "../src/agent/tools.ts";
import { Master } from "../src/master.ts";
import { buildApp } from "../src/server/api.ts";
import path from "node:path";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" };

function mkMaster(dataDir: string, ws: string): Master {
  return new Master(
    {
      port: 0,
      dataDir,
      llm: LLM,
      providers: {},
      agents: [{ id: "j1", workspace: ws, provider: "p", session: "j1" }],
    } as never,
    path.join(dataDir, "config.json"),
  );
}

const ctxFor = (ws: string) => ({ cwd: ws, signal: undefined, maxOutputBytes: 1_000_000 }) as never;

async function startedMaster(dataDir: string, ws: string): Promise<Master> {
  const m = mkMaster(dataDir, ws);
  await m.start();
  return m;
}

test("GET /api/agents/:id/bg-jobs lists a running job with its tail (#bgjobs)", async () => {
  const ws = mkdtempInRootSync("bgjobs-route-");
  const dataDir = mkdtempInRootSync("bgjobs-data-");
  await executeTool("bash", JSON.stringify({ command: "echo via-route; sleep 30", background: true }), ctxFor(ws));
  await new Promise((res) => setTimeout(res, 900));

  const app = buildApp(await startedMaster(dataDir, ws));
  const r = await app.request("/api/agents/j1/bg-jobs");
  assert.equal(r.status, 200);
  const { jobs } = (await r.json()) as { jobs: Array<Record<string, unknown>> };

  assert.equal(jobs.length, 1, "the route must list the job");
  const j = jobs[0]!;
  for (const key of ["id", "cmd", "owner", "running", "startedAt", "tail", "bytes", "truncated"]) {
    assert.ok(key in j, `the popover reads "${key}", so the route must send it`);
  }
  assert.equal(j.running, true, "and it must say it is running");
  assert.match(String(j.tail), /via-route/, "the tail IS the 'live output' that was asked for");
  assert.ok(String(j.tail).length <= 4000, "bounded, so a huge log does not travel to the browser");
  assert.ok(String(j.cmd).includes("sleep 30"), "the command, so the operator knows what it is");

  await app.request(`/api/agents/j1/bg-jobs/${String(j.id)}`, { method: "DELETE" });
});

test("DELETE /api/agents/:id/bg-jobs/:job kills it; unknown ids are 404 (#bgjobs)", async () => {
  const ws = mkdtempInRootSync("bgjobs-del-");
  const dataDir = mkdtempInRootSync("bgjobs-deldata-");
  await executeTool("bash", JSON.stringify({ command: "sleep 30", background: true }), ctxFor(ws));
  await new Promise((res) => setTimeout(res, 500));

  const app = buildApp(await startedMaster(dataDir, ws));
  const before = (await (await app.request("/api/agents/j1/bg-jobs")).json()) as { jobs: Array<{ id: string }> };
  assert.equal(before.jobs.length, 1, "precondition");

  const kill = await app.request(`/api/agents/j1/bg-jobs/${before.jobs[0]!.id}`, { method: "DELETE" });
  assert.equal(kill.status, 200);
  assert.deepEqual(((await kill.json()) as { ok: boolean }).ok, true);

  const after = (await (await app.request("/api/agents/j1/bg-jobs")).json()) as { jobs: unknown[] };
  assert.equal(after.jobs.length, 0, "the row is gone after the kill");

  const stale = await app.request("/api/agents/j1/bg-jobs/no-such-job", { method: "DELETE" });
  assert.equal(stale.status, 404, "an unknown job is a 404, not a crash");
});

test("an unknown agent is 404, not an empty list (#bgjobs)", async () => {
  const dataDir = mkdtempInRootSync("bgjobs-nobody-");
  const app = buildApp(await startedMaster(dataDir, mkdtempInRootSync("bgjobs-ws-")));
  const r = await app.request("/api/agents/nobody/bg-jobs");
  assert.equal(r.status, 404, "an empty list would read as 'no jobs', which is a different answer");
});
