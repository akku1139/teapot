/**
 * A running background job's tail and clock must LIVE-UPDATE while the panel is open (#290).
 *
 * Reported twice: "background shells パネルが開いたときの状態で固定されて、時刻カウントもライブ更新も進まない". Two separate causes,
 * and fixing one hides the other:
 *
 *   1. nothing PUSHED. `agent-update` fires on start and on exit, so a panel opened in between received no frame at all and
 *      stayed frozen at the state it was opened with. The 2-second poll that used to hide this was removed (correctly — a
 *      `Map`-sized poll per panel), and with it the only thing that refreshed the tail.
 *   2. the elapsed time was `fmtDur(Date.now() - startedAt)` in the template: `Date.now()` is not reactive, so the number froze
 *      at the instant of the last render even when frames did arrive. The same bug had already been fixed twice in
 *      `code.tsx`; `frontend/lib/ticker.ts` is now the one owner.
 *
 * This file covers (1) — that the writer pushes when it writes, throttled. (2) is a rendering property, covered by the bundle
 * smoke check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { executeTool, type ToolContext } from "../src/agent/tools.ts";
import { waitFor } from "./helpers/wait-for.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("spawns real shells");

function ctxWithPushes(): { ctx: ToolContext; pushes: { id: string; at: number }[] } {
  const pushes: { id: string; at: number }[] = [];
  const ctx = {
    cwd: mkdtempInRootSync("bg-push-"),
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 4_000,
    skillRoots: [],
    // the startup window is off: this is about pushes AFTER the job is running
    bgStartupMs: 0,
    onBackgroundOutput: (id: string) => pushes.push({ id, at: Date.now() }),
  } as unknown as ToolContext;
  return { ctx, pushes };
}

test("output growth pushes a snapshot, so an open panel is not frozen", async () => {
  const { ctx, pushes } = ctxWithPushes();
  const r = await executeTool(
    "bash",
    // writes for ~2.4s, so the 1s throttle admits more than one push: a burst inside one window is ONE push by design
    JSON.stringify({ command: "for i in 1 2 3 4 5 6; do echo tick $i; sleep 0.4; done; sleep 4", background: true }),
    ctx,
  );
  assert.match(r.result, /bg\d+/, `a running job is expected; got ${r.result}`);

  await waitFor(() => pushes.length >= 2, { what: "at least two pushes while the job wrote" });
  assert.ok(pushes.every((p) => p.id === pushes[0]!.id), "every push names the same running job");
});

test("the pushes are THROTTLED — a chatty job must not flood the socket", async () => {
  const { ctx, pushes } = ctxWithPushes();
  // writes ~100 times in a second: one push per write would be 100 snapshots of an ever-growing tail
  await executeTool(
    "bash",
    JSON.stringify({ command: "for i in $(seq 1 100); do echo line $i; done; sleep 3", background: true }),
    ctx,
  );
  await waitFor(() => pushes.length >= 1, { what: "the first push" });
  await new Promise((r) => setTimeout(r, 500));

  assert.ok(
    pushes.length <= 3,
    `pushes must be throttled to about one per second; saw ${pushes.length} for a job that wrote 100 times`,
  );
});

test("a job that never writes pushes nothing", async () => {
  const { ctx, pushes } = ctxWithPushes();
  await executeTool("bash", JSON.stringify({ command: "sleep 3", background: true }), ctx);
  await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual(pushes, [], "there is no new tail to send, so there is nothing to push");
});
