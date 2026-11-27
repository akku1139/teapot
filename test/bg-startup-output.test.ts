/**
 * `bash(background=true)` reports the job's first output, and CONCURRENCY must not blur the jobs (#297).
 *
 * "出力して即exitなら5秒枠内でoutputが取れるから次のターンまで待つ必要ないのでは? / あと、並列実行中のジョブがあってもちゃんとされることも
 * チェック / (即exitの場合はbg job idを割り振るべきかも)".
 *
 * Three rules, and each one is a way the feature can be wrong:
 *
 *   1. a command that finishes inside the window is a FINISHED COMMAND, not a background job: its output and exit code are in
 *      the result, no wake is emitted, and no job id is left behind — an id is a handle for `bash_output`/`kill`, neither of
 *      which applies to something already done;
 *   2. a job that prints and then keeps running is NOT held for the whole window (that would delay every dev server by five
 *      seconds), so the collection stops shortly after the first output — "prints, then dies" still lands inside that grace;
 *   3. with several jobs in flight — same workspace and different — each result carries ITS OWN job's output, ids are
 *      distinct, and discarding a finished one does not disturb the others.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { executeTool, listBgShells, type ToolContext } from "../src/agent/tools.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";
import { waitFor } from "./helpers/wait-for.ts";

markPosixOnly("spawns real shells");

function ctxFor(cwd: string, exits: string[] = []): ToolContext {
  return {
    cwd,
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 8_000,
    skillRoots: [],
    onBackgroundExit: (info: { id: string; code: number | null }) => {
      exits.push(`${info.id} exit=${info.code}`);
    },
  } as unknown as ToolContext;
}

/** the result body without the "other running jobs" listing, which names OTHER jobs' commands on purpose (#231) */
const outputSection = (result: string): string =>
  result
    .split("\n")
    .filter((l) => !/^started in background|^You are WOKEN|^Output mid-run|^Do not start|^running background jobs|^  bg/.test(l))
    .join("\n");

test("a command that exits inside the window is a finished command, with no id and no wake", async () => {
  const ws = mkdtempInRootSync("bg297-exit0-");
  const exits: string[] = [];
  const ctx = ctxFor(ws, exits);

  const r = await executeTool("bash", JSON.stringify({ command: "echo all good; exit 0", background: true }), ctx);

  assert.equal(r.ok, true, "exit 0 is a success");
  assert.match(r.result, /not a background job/, "it is reported as a finished command");
  assert.match(r.result, /all good/, "with its output");
  assert.match(r.result, /exit 0/, "and its code");
  assert.ok(!/bg\d+/.test(r.result), "no job id: there is nothing to read, stop or wait for");
  assert.ok(!/WOKEN/i.test(r.result), "and nothing promising a wake");
  assert.deepEqual(listBgShells(ws), [], "and nothing left in the panel");

  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(exits, [], "a wake for news already delivered would start a pointless round");
});

test("a NON-zero exit inside the window is also folded in, and says it failed", async () => {
  const ws = mkdtempInRootSync("bg297-exit1-");
  const exits: string[] = [];
  const r = await executeTool(
    "bash",
    JSON.stringify({ command: "echo 'FATAL: no such config'; exit 3", background: true }),
    ctxFor(ws, exits),
  );

  assert.equal(r.ok, false, "a failed command is a failed tool call");
  assert.match(r.result, /exit 3/);
  assert.match(r.result, /FATAL: no such config/);
  assert.deepEqual(listBgShells(ws), [], "nothing left behind");
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(exits, [], "still no wake");
});

test("prints and keeps running: not held for the whole window, and it keeps its wake", async () => {
  const ws = mkdtempInRootSync("bg297-server-");
  const exits: string[] = [];
  const t0 = Date.now();
  const r = await executeTool(
    "bash",
    JSON.stringify({ command: "echo listening; sleep 30", background: true }),
    ctxFor(ws, exits),
  );
  const elapsed = Date.now() - t0;

  assert.equal(r.ok, true, "a running job is not a failure");
  assert.match(r.result, /listening/, "its startup output is there");
  assert.match(r.result, /WOKEN/i, "and the wake is promised, because it is still running");
  assert.match(r.result, /bg\d+/, "with a handle for bash_output/kill");
  assert.ok(elapsed < 4_000, `a server must not be held for the whole window; took ${elapsed}ms`);

  const jobs = listBgShells(ws);
  assert.equal(jobs.length, 1, "and it IS a background job");
  assert.equal(jobs[0]!.running, true);
});

test("prints, then dies shortly after: still folded into the result, not left for a wake", async () => {
  const ws = mkdtempInRootSync("bg297-crash-");
  const exits: string[] = [];
  const r = await executeTool(
    "bash",
    JSON.stringify({ command: "echo booting; sleep 0.3; exit 2", background: true }),
    ctxFor(ws, exits),
  );

  assert.equal(r.ok, false, "exit 2");
  assert.match(r.result, /not a background job/, "the grace after the first output is what catches this");
  assert.match(r.result, /booting/);
  assert.deepEqual(listBgShells(ws), [], "nothing left in the panel");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(exits, [], "and no wake");
});

test("concurrent jobs in the SAME workspace keep their own output and ids", async () => {
  const ws = mkdtempInRootSync("bg297-parallel-");
  const exits: string[] = [];
  const ctx = ctxFor(ws, exits);

  const [a, b] = await Promise.all([
    executeTool("bash", JSON.stringify({ command: "sleep 0.2; echo FIRST; sleep 30", background: true }), ctx),
    executeTool("bash", JSON.stringify({ command: "sleep 0.2; echo SECOND; sleep 30", background: true }), ctx),
  ]);

  const idOf = (r: { result: string }) => /bg\d+/.exec(r.result)?.[0] ?? "";
  assert.notEqual(idOf(a), idOf(b), "two jobs, two ids");

  const bodyA = outputSection(a.result);
  const bodyB = outputSection(b.result);
  assert.match(bodyA, /FIRST/, "each result carries its own output");
  assert.ok(!/SECOND/.test(bodyA), "not the other job's — the listing below names it separately, on purpose");
  assert.match(bodyB, /SECOND/);
  assert.ok(!/FIRST/.test(bodyB));

  assert.equal(listBgShells(ws).length, 2, "both are listed");
});

test("a finished command in one workspace does not disturb running jobs in another", async () => {
  const wsA = mkdtempInRootSync("bg297-wsA-");
  const wsB = mkdtempInRootSync("bg297-wsB-");
  const ctxA = ctxFor(wsA);
  const ctxB = ctxFor(wsB);

  const running = await executeTool("bash", JSON.stringify({ command: "sleep 30", background: true }), ctxA);
  assert.match(running.result, /bg\d+/);

  // an instantly-finished command in the OTHER workspace must not remove it
  const quick = await executeTool("bash", JSON.stringify({ command: "echo quick; exit 0", background: true }), ctxB);
  assert.match(quick.result, /not a background job/);

  assert.equal(listBgShells(wsA).length, 1, "the running job survives");
  assert.deepEqual(listBgShells(wsB), [], "and only its own finished command was dropped");
});

/**
 * A KILL ends the job inside the tool result — no second message about it.
 *
 * Reported: "bash_output kill をした場合はそのツールレスポンス内で終了までやって、`[harness] Background job report:` が発行されるべきじゃ
 * ないと思う / これのせいでLLMが変な挙動してるって節がある". The wake is a second signal for one event, and in a long session the model read
 * the late report as ANOTHER job's ending — it went on to reason about ids it had already stopped.
 *
 * The rules this pins: the result says the job ENDED (its code, not "was asked to stop"), the exit hook is never called, and the job
 * is gone from the registry, so nothing can report it afterwards.
 */
test("a kill reports the exit in its own result, and never as a background job report", async () => {
  const ws = mkdtempInRootSync("bg297-kill-");
  const exits: string[] = [];
  const ctx = ctxFor(ws, exits);

  const started = await executeTool("bash", JSON.stringify({ command: "sleep 60", background: true }), ctx);
  const id = /job (bg\d+)/.exec(started.result)?.[1];
  assert.ok(id, `the start result must name the job: ${started.result}`);
  // PRECONDITION: the job really is running, or the kill below proves nothing
  await waitFor(() => listBgShells(ws).some((j) => j.id === id), { what: "the background job to be registered" });

  const killed = await executeTool("bash_output", JSON.stringify({ job_id: id, action: "kill" }), ctx);

  // a killed child reports `code: null` and a SIGNAL, so the result must name whichever ending actually happened
  assert.match(killed.result, /exited with code|stopped \(signal/, `the result must say the job ENDED: ${killed.result}`);
  assert.deepEqual(exits, [], "a kill must not announce itself — the caller was told inside its own result");
  assert.deepEqual(listBgShells(ws).map((j) => j.id), [], "and the job must be gone, so nothing can report it later");
});
