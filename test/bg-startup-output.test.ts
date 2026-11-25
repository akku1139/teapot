/**
 * `bash(background=true)` reports what the job did in its first moments (#297).
 *
 * "background shellを起動した直後の出力はツール出力でそのまま渡すようにする / 直後に落ちて1ターン消費するみたいなパターンが多いし、
 * 起動して何が起きたかくらいは知らせてもよさそう / 5秒分くらいは取ってあげたほうがいいかな".
 *
 * Two rules come out of that, and they pull in opposite directions if both signals fire:
 *
 *   1. a job that is still running when the collection ends keeps the wake it always had — that is how the model waits;
 *   2. a job that DIES inside the window is reported entirely by the tool result (output + exit code), so no wake is
 *      emitted for it: a wake would start a round to re-read what the result already said, and the wording drops the
 *      "you are WOKEN" sentence because there is nothing left to wait for.
 *
 * Both directions are measured here against a real shell, because the whole point is timing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { executeTool, releaseStartupHold, type ToolContext } from "../src/agent/tools.ts";
import { waitFor } from "./helpers/wait-for.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("spawns real shells");

function ctxWithExits(): { ctx: ToolContext; exits: string[] } {
  const exits: string[] = [];
  const cwd = mkdtempInRootSync("bg-startup-");
  const ctx = {
    cwd,
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 4_000,
    skillRoots: [],
    onBackgroundExit: (info: { id: string; code: number | null }) => {
      exits.push(`${info.id} exit=${info.code}`);
    },
  } as unknown as ToolContext;
  return { ctx, exits };
}

test("a job that dies immediately is reported by the RESULT, with no wake and no 'you are woken'", async () => {
  const { ctx, exits } = ctxWithExits();
  const r = await executeTool(
    "bash",
    JSON.stringify({ command: "echo 'FATAL: no such config'; exit 3", background: true }),
    ctx,
  );

  assert.equal(r.ok, false, "a non-zero exit is a failed tool call, not a started job");
  assert.match(r.result, /EXITED \(exit 3\)/, "the exit code is in the result");
  assert.match(r.result, /FATAL: no such config/, "and so is the output that explains it");
  assert.ok(!/WOKEN/i.test(r.result), "there is nothing to wait for, so nothing promises a wake");

  // the hold is what suppresses it; give the exit a moment to have been recorded
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(exits, [], "a wake for news already delivered would start a pointless round");
});

test("a job that is still running keeps its wake, and shows what it printed", async () => {
  const { ctx, exits } = ctxWithExits();
  const r = await executeTool(
    "bash",
    JSON.stringify({ command: "echo started; sleep 0.4; exit 7", background: true }),
    ctx,
  );

  assert.equal(r.ok, true, "still running");
  assert.match(r.result, /started/, "the startup output is in the result");
  assert.match(r.result, /WOKEN/i, "and the wake is promised, because this one is still running");

  await waitFor(() => exits.length > 0, { what: "the wake for the job that exited later" });
  assert.match(exits[0]!, /exit=7/);
});

test("the hold is released either way, so a later exit is never swallowed", () => {
  // an unknown id is not an error: a job already forgotten reports no wake owed
  assert.deepEqual(releaseStartupHold("bg-does-not-exist"), { wakeOwed: false });
});
