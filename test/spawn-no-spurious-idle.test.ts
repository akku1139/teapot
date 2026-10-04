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
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Master } from "../src/master.ts";

const master = readFileSync(new URL("../src/master.ts", import.meta.url), "utf8");

async function spawnAndCollectPrompts() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "t130a-"));
  const ws = mkdtempSync(path.join(os.tmpdir(), "t130w-"));
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

test("the wakeup itself is NOT gated — only the message is (#130)", async () => {
  // gating the whole handler would reintroduce #126: a parent's wait_children must
  // wake on the birth transition too, or it sits until the child really runs
  // Anchor on the two symbols and compare their positions in the FILE, not in a
  // fixed-width slice: a 900-char window found the wake at 290 and the gate at
  // -1, because #130's comment pushed it past the edge — the same trap as #126.
  const wakeAt = master.indexOf("this.wakeParentWaiters(ac.parent);");
  const gateAt = master.indexOf("this.reportedRunning.has(agentId)");
  assert.notEqual(wakeAt, -1, "the wake must be there (#126)");
  assert.notEqual(gateAt, -1, "the report gate must be there (#130)");
  assert.ok(
    wakeAt < gateAt,
    `the wake must not be gated by the report condition (#130): wake@${wakeAt} gate@${gateAt}`,
  );
});

test("a settled report requires the child to have run (#130)", async () => {
  const at = master.indexOf("this.reportedRunning.has(agentId)");
  assert.notEqual(at, -1, "the gate must exist (#130)");
  const block = master.slice(at, at + 400);
  assert.match(block, /SETTLED\.has\(status\)/, "and only for a settled status (#130)");
  // the gate must be ARMED when the child starts, or a real completion never reports
  assert.match(
    master,
    /if \(status === "running"\) this\.reportedRunning\.add\(agentId\);/,
    "reaching running must arm the gate (#130)",
  );
  assert.match(
    master,
    /else if \(SETTLED\.has\(status\)\) this\.reportedRunning\.delete\(agentId\);/,
    "and settling disarms it, so a later idle is not re-reported (#130)",
  );
});
