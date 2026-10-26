import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { executeTool, listBgShells, killBgShell, recoverableJobs } from "../src/agent/tools.ts";

const ctxFor = (ws: string, stateDir: string) =>
  ({ cwd: ws, agentId: "a1", stateDir, signal: undefined, maxOutputBytes: 1_000_000 }) as never;

test("a job is recoverable from its record after the owning process is gone (#bgjobs)", async () => {
  const ws = mkdtempInRootSync("bgjobs-restart-");
  const state = mkdtempInRootSync("bgjobs-state-");
  await executeTool("bash", JSON.stringify({ command: "sleep 5", background: true }), ctxFor(ws, state));
  await new Promise((r) => setTimeout(r, 400));

  const recovered = recoverableJobs(state, () => true);
  assert.equal(recovered.length, 1, "the record must survive");
  assert.match(recovered[0]!.cmd, /sleep 5/, "with the command, so the operator knows what it is");
  assert.equal(typeof recovered[0]!.pid, "number", "and the pid, so it can be checked");
  assert.equal(recovered[0]!.owner, "a1", "and which agent started it");

  assert.deepEqual(recoverableJobs(state, () => false), [], "a dead pid is not a running job");
});

test("a detached job is LISTED as running but marked detached (#bgjobs)", async () => {
  const ws = mkdtempInRootSync("bgjobs-det-");
  const state = mkdtempInRootSync("bgjobs-detstate-");
  await executeTool("bash", JSON.stringify({ command: "sleep 5", background: true }), ctxFor(ws, state));
  await new Promise((r) => setTimeout(r, 400));

  const live = listBgShells(ws, state);
  assert.equal(live.length, 1);
  assert.notEqual(live[0]!.detached, true, "while this process owns it, it is a normal job");
  assert.ok(live[0]!.tail !== undefined, "and its output is readable");

  assert.equal(recoverableJobs(state, () => true).length, 1);
});

test("forgetting a detached job never signals its pid (#bgjobs)", async () => {
  const ws = mkdtempInRootSync("bgjobs-forget-");
  const state = mkdtempInRootSync("bgjobs-forgetstate-");
  await executeTool("bash", JSON.stringify({ command: "sleep 5", background: true }), ctxFor(ws, state));
  await new Promise((r) => setTimeout(r, 400));
  const rec = recoverableJobs(state, () => true)[0]!;
  const pid = rec.pid!;

  const other = mkdtempInRootSync("bgjobs-other-");
  assert.equal(killBgShell(other, rec.id, state), true, "the record is found and dropped");
  assert.equal(recoverableJobs(state, () => true).length, 0, "and it is gone from disk");

  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, true, "forgetting a record must not kill the process it names");

  try {
    process.kill(pid, "SIGKILL");
  } catch {
  }
});

test("a finished job leaves no record behind (#bgjobs)", async () => {
  const ws = mkdtempInRootSync("bgjobs-done-");
  const state = mkdtempInRootSync("bgjobs-donestate-");
  await executeTool("bash", JSON.stringify({ command: "echo bye; exit 0", background: true }), ctxFor(ws, state));
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(recoverableJobs(state, () => true), [], "an exited job must not be recoverable");
});
