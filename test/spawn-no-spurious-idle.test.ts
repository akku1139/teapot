/**
 * #130 — "the instant a sub-agent is spawned, `[subagent] is now idle` is
 * returned to the parent."
 *
 *     [harness] @tyb2-6-sub-vibrator is now idle. Continue your task, or finish()
 *     if the work is done.
 *
 * ## Cause — a regression I introduced in efc4a2f
 *
 * #126 added the control plane (`onControlStatusChange`) so `wait_children`
 * wakeups no longer depend on the log write succeeding. With it I made the parent
 * nudge itself whenever a child settled:
 *
 *     if (status === "idle" || …) parent.enqueuePrompt(`@${agentId} is now ${status}`)
 *
 * But a spawned child is `idle` BEFORE it starts. `addAgent` creates it at
 * `stopped`, the first `ensureReady()` flips it to `idle`, and only then does
 * `start()` run. So the birth transition was always `idle` — reported as a
 * completion.
 *
 * Traced from a real `spawnChildFor`:
 *
 *     p1-sub ◆ state stopped→idle (session loaded)     <- reported as "is now idle"
 *     p1-sub ▶ state idle→running (spawned by p1)
 *
 * The fix requires a child to have actually reached `running` before its
 * `idle` counts as settling. The `wakeParentWaiters` call above stays
 * unconditional, so `wait_children` is unaffected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import path from "node:path";
import { Master } from "../src/master.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";


async function spawnAndCollectPrompts() {
  const dataDir = mkdtempInRootSync("t130a-");
  const ws = mkdtempInRootSync("t130w-");
  const m = new Master(
    {
      port: 0,
      dataDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" },
      providers: {},
      agents: [],
    },
    // #126: NOT "/dev/null". Every existing test passes that, and it works on Linux
    // because the file need not exist — but on Windows "/dev/null" resolves
    // RELATIVE TO THE CURRENT DRIVE as "D:\dev\null", and spawnChildFor reads it,
    // so the test failed there with ENOENT. A real per-test path is portable.
    path.join(dataDir, "config.json"),
  );
  const parent = await m.addAgent({ id: "p1", workspace: ws }, { persist: false });
  const prompts: string[] = [];
  const orig = parent.enqueuePrompt.bind(parent);
  parent.enqueuePrompt = (t: string, s?: string, i?: unknown) => {
    prompts.push(String(t));
    return orig(t, s, i as never);
  };
  await m.spawnChildFor(parent, { task: "do a thing", context: "none" });
  await new Promise((r) => setTimeout(r, 300));
  // the child is a REAL agent running against an unreachable provider, so it would
  // keep retrying (and hold the loop open) long after the assertion. Stop it.
  for (const a of [...m.agents.values()]) a.stop("test done");
  for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  return { prompts };
}

test("spawning a sub-agent does NOT tell the parent it is idle (#130)", async () => {
  const { prompts } = await spawnAndCollectPrompts();
  const spurious = prompts.filter((p) => /is now idle/.test(p));
  assert.deepEqual(
    spurious,
    [],
    `a freshly spawned child must not be reported as settled (#130): ${JSON.stringify(spurious[0])}`,
  );
});
