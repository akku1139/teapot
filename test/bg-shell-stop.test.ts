/**
 * #158 — "bash実行中にstopできない?" / "bash関係なくstopできないわ" (v0.29.13).
 *
 * ## What was measured
 *
 * The FOREGROUND path is sound and was verified end-to-end through the real HTTP
 * API: with a `sleep 90` running, `POST /api/agents/<id>/stop` returned, the agent
 * went `stopped`, and the child process was gone. So the report is not reproducible
 * as stated against v0.29.13's code path, and the two defects below are the ones
 * that WERE reproducible. Both are the same shape: work that `stop()` claims to end
 * and does not.
 *
 * 1. BACKGROUND shells (`bash background=true`) were never killed. They are spawned
 *    `detached: true` for group-killing and outlive the tool call that started them,
 *    so `toolAbort` — which only reaches a tool still on the stack — cannot touch
 *    them. MEASURED: `sleep 300` outlived both `stop()` and `dispose()`.
 *
 * 2. A running background job did not make the agent LIVE. The round that starts one
 *    deliberately ends (the loop breaks instead of nagging — see
 *    `hasRunningBgShells` in `loop()`), so the status reads "idle" while a dev
 *    server / watcher / long build is very much running. `isLive()` returned false,
 *    so the UI offered **▶ start** and there was no stop control for the one thing
 *    the operator most needs to stop. This is #59's trap again, in a new state.
 *
 * Both are asserted through the real agent rather than on a helper, because both are
 * WIRING defects — a helper test would have passed against the broken code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

// #110: POSIX-only — the fixture starts a `sleep` through the bash tool, which
// spawns /bin/bash. On Windows that is ENOENT, so the failure would be the
// fixture's platform, not the product's behaviour.
markPosixOnly("starts a background shell through the bash tool");

const reply = (content: string, calls?: unknown[]): LlmResult => ({
  // `tool_calls` is a typed array on ChatMessage; the loose `unknown[]` here is a test
  // convenience, so the cast is local to the fixture
  message: {
    role: "assistant",
    content,
    ...(calls ? { tool_calls: calls as NonNullable<LlmResult["message"]["tool_calls"]> } : {}),
  },
});

/** a `bash` tool call starting a background job that would touch `probe` */
const bgCall = (probe: string) => ({
  id: "c1",
  type: "function" as const,
  function: {
    name: "bash",
    arguments: JSON.stringify({ command: `sleep 6; touch ${probe}`, background: true }),
  },
});

async function startBgAgent(ws: string, sd: string, probe: string) {
  let calls = 0;
  const agent = new Agent({
    id: "bg",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (): Promise<LlmResult> => {
      calls++;
      if (calls === 1) return reply("", [bgCall(probe)]);
      return reply("done");
    },
    autoContinue: true,
    continueDelayMs: 300,
  } as never);
  await agent.init();
  agent.enqueuePrompt("go");
  agent.start("t");
  // let the tool call land and the job register
  for (let i = 0; i < 60 && calls < 2; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  return agent;
}

test("a running BACKGROUND shell makes the agent live — the UI must offer stop (#158)", async () => {
  await useTempDirs(["bg158a-", "bg158b-"], async ([ws, sd]) => {
    const probe = path.join(ws!, "never-touched.txt");
    const agent = await startBgAgent(ws!, sd!, probe);
    try {
      // precondition: the job really is running, or this test is vacuous
      assert.equal(
        agent.status,
        "idle",
        "precondition: the round that started the bg job ENDS, leaving status idle (#158)",
      );
      assert.equal(
        agent.isLive(),
        true,
        "a running background job is work `stop` would stop, so the agent is live (#158) — " +
          "false here is why the UI showed '▶ start' and offered no way to stop it",
      );
    } finally {
      await agent.dispose();
    }
  });
});

test("stop() KILLS a running background shell instead of leaving it behind (#158)", async () => {
  await useTempDirs(["bg158c-", "bg158d-"], async ([ws, sd]) => {
    const probe = path.join(ws!, "touched-after-stop.txt");
    const agent = await startBgAgent(ws!, sd!, probe);
    try {
      agent.stop("stopped via api");
      await Promise.race([agent.settled(), new Promise((r) => setTimeout(r, 4000))]);
      // once stopped the jobs are dead, so `live` must go false — otherwise the
      // single start/stop toggle would offer stop forever (#133)
      assert.equal(agent.isLive(), false, "after a stop the agent is not live (#133/#158)");
      // the job would touch this file at t+6s; wait past that
      await new Promise((r) => setTimeout(r, 7_500));
      assert.equal(
        fs.existsSync(probe),
        false,
        "the background job outlived stop() and completed after it (#158) — measured with `sleep 300`",
      );
    } finally {
      await agent.dispose();
    }
  });
});

test("dispose() kills a running background shell too — shutdown must not orphan jobs (#158)", async () => {
  await useTempDirs(["bg158e-", "bg158f-"], async ([ws, sd]) => {
    const probe = path.join(ws!, "touched-after-dispose.txt");
    const agent = await startBgAgent(ws!, sd!, probe);
    await agent.dispose();
    await new Promise((r) => setTimeout(r, 7_500));
    assert.equal(
      fs.existsSync(probe),
      false,
      "a background job survived harness shutdown, still burning CPU with nothing tracking it (#158)",
    );
  });
});
