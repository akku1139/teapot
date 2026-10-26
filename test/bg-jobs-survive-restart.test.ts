import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { executeTool, listBgShells, killBgShell, recoverableJobs } from "../src/agent/tools.ts";

/**
 * A job that outlives the harness must not VANISH from the UI.
 *
 * MEASURED on the operator's machine: a `nohup` GPU sweep started at 10:28 kept writing for three
 * hours while the harness was OOM-killed and restarted at 13:09. The process was fine — `nohup` did
 * exactly its job — but the new instance answered `unknown background job … forgotten on harness
 * restart`, and the panel showed nothing for work that was still in progress.
 *
 * The process CANNOT be re-attached: `bgShellsByWs` holds a `ChildProcess`, and no fd survives the
 * parent. So the honest contract is a RECORD — "pid N is still running, its output is not reachable
 * from here" — which is what these tests pin.
 *
 * The suite never signals a pid it only remembers, and every pid used here is a throwaway `sleep`
 * this test started and then reaped.
 */
const ctxFor = (ws: string, stateDir: string) =>
  ({ cwd: ws, agentId: "a1", stateDir, signal: undefined, maxOutputBytes: 1_000_000 }) as never;

test("a job is recoverable from its record after the owning process is gone (#bgjobs)", async () => {
  const ws = mkdtempInRootSync("bgjobs-restart-");
  const state = mkdtempInRootSync("bgjobs-state-");
  await executeTool("bash", JSON.stringify({ command: "sleep 5", background: true }), ctxFor(ws, state));
  await new Promise((r) => setTimeout(r, 400));

  // what a NEW process sees: no in-memory job, only the record on disk
  const recovered = recoverableJobs(state, () => true);
  assert.equal(recovered.length, 1, "the record must survive");
  assert.match(recovered[0]!.cmd, /sleep 5/, "with the command, so the operator knows what it is");
  assert.equal(typeof recovered[0]!.pid, "number", "and the pid, so it can be checked");
  assert.equal(recovered[0]!.owner, "a1", "and which agent started it");

  // once the process is gone the record is stale and must be dropped, not reported as running
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

  // the record survives in the file even though the in-memory handle is what the list mostly uses
  assert.equal(recoverableJobs(state, () => true).length, 1);
});

test("forgetting a detached job never signals its pid (#bgjobs)", async () => {
  /**
   * The operator's own instruction: never touch a job from an earlier session. A pid we merely
   * REMEMBER can be reused by an unrelated process, so acting on it is how the wrong thing gets
   * killed. `killBgShell` may drop the record; it may not signal.
   */
  const ws = mkdtempInRootSync("bgjobs-forget-");
  const state = mkdtempInRootSync("bgjobs-forgetstate-");
  await executeTool("bash", JSON.stringify({ command: "sleep 5", background: true }), ctxFor(ws, state));
  await new Promise((r) => setTimeout(r, 400));
  const rec = recoverableJobs(state, () => true)[0]!;
  const pid = rec.pid!;

  // a second workspace with no in-memory job: only the record is there
  const other = mkdtempInRootSync("bgjobs-other-");
  assert.equal(killBgShell(other, rec.id, state), true, "the record is found and dropped");
  assert.equal(recoverableJobs(state, () => true).length, 0, "and it is gone from disk");

  // proof the process was NOT signalled: it is still alive
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, true, "forgetting a record must not kill the process it names");

  // reap it ourselves — this test started it
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
});

test("a finished job leaves no record behind (#bgjobs)", async () => {
  /**
   * A record that outlives its job claims a pid that no longer exists. On the next boot
   * `recoverableJobs` would have to notice — but the honest state is that there is nothing to report,
   * so the exit path removes it.
   */
  const ws = mkdtempInRootSync("bgjobs-done-");
  const state = mkdtempInRootSync("bgjobs-donestate-");
  await executeTool("bash", JSON.stringify({ command: "echo bye; exit 0", background: true }), ctxFor(ws, state));
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(recoverableJobs(state, () => true), [], "an exited job must not be recoverable");
});
