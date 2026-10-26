import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { executeTool, listBgShells, killBgShell } from "../src/agent/tools.ts";

const ctxFor = (ws: string) => ({ cwd: ws, signal: undefined, maxOutputBytes: 1_000_000 }) as never;

test("a started job is listed with its command, owner and LIVE tail (#bgjobs)", async () => {
  const ws = mkdtempInRootSync("bgjobs-list-");
  const r = await executeTool("bash", JSON.stringify({ command: "echo hello-from-bg; sleep 30", background: true }), ctxFor(ws));
  assert.ok(String(r.result).includes("started in background"), String(r.result));

  await new Promise((res) => setTimeout(res, 800));

  const jobs = listBgShells(ws);
  assert.equal(jobs.length, 1, "the job must be listed");
  assert.equal(jobs[0]!.running, true, "and reported as running");
  assert.match(jobs[0]!.tail, /hello-from-bg/, "the tail must carry what it printed — that is the 'live output'");
  assert.ok(jobs[0]!.cmd.includes("sleep 30"), "and the command, so the operator knows what it is");
  assert.equal(typeof jobs[0]!.startedAt, "number", "elapsed time comes from this");

  killBgShell(ws, jobs[0]!.id);
});

test("killing removes it, and an unknown id is not an error (#bgjobs)", async () => {
  const ws = mkdtempInRootSync("bgjobs-kill-");
  await executeTool("bash", JSON.stringify({ command: "sleep 30", background: true }), ctxFor(ws));
  await new Promise((res) => setTimeout(res, 300));
  const [job] = listBgShells(ws);
  assert.ok(job, "precondition: a job exists");

  assert.equal(killBgShell(ws, job!.id), true, "kill reports that it existed");
  assert.equal(listBgShells(ws).length, 0, "and the job is gone from the list");

  assert.equal(killBgShell(ws, "no-such-job"), false, "an unknown id reports false, not a throw");
});

test("a job that has finished stays listed with its exit code (#bgjobs)", async () => {
  const ws = mkdtempInRootSync("bgjobs-done-");
  await executeTool("bash", JSON.stringify({ command: "echo done-now; exit 3", background: true }), ctxFor(ws));
  await new Promise((res) => setTimeout(res, 900));

  const [job] = listBgShells(ws);
  assert.ok(job, "the finished job must still be listed");
  assert.equal(job!.running, false, "and reported as finished");
  assert.equal(job!.code, 3, "with its exit code");
  assert.match(job!.tail, /done-now/, "and its output");
});
