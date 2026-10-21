/**
 * #158 — "bash実行中にstopできない? / bash関係なくstopできない".
 *
 * A job spawned with `background: true` is `detached` and its spawning tool returned long
 * before, so neither the LLM-call abort nor `toolAbort` can reach it: the agent parked waiting
 * for the job while the job kept running, and `stop()` — the exact control an operator presses
 * for this — ended nothing. MEASURED at the time: `sleep 300` outlived both `stop()` and
 * `dispose()`.
 *
 * The stop path now kills the background shells for the workspace and wakes the loop. This
 * pins the PROPERTY rather than the implementation: after stop() returns, no shell belonging
 * to this agent may still be running, and the parked loop must be released.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";
import { Agent } from "../src/agent/agent.ts";
import { hasRunningBgShellsFor } from "../src/agent/tools.ts";

markPosixOnly("spawns a real background shell");

test("stop() ends a background shell the agent is waiting on (#158)", async () => {
  const dir = mkdtempInRootSync("bgstop-");
  const sd = mkdtempInRootSync("bgstops-");
  let n = 0;
  const agent = new Agent({
    id: "bgstop",
    workspace: dir,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      n++;
      if (n === 1)
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "bg1",
                type: "function",
                function: {
                  name: "bash",
                  // long enough that only a stop can end it
                  arguments: JSON.stringify({ command: "sleep 120", background: true }),
                },
              },
            ],
          },
        } as never;
      return { message: { role: "assistant", content: "done" } } as never;
    },
    autoContinue: false,
  } as never) as Agent;

  await agent.init();
  try {
    agent.enqueuePrompt("start a job");
    agent.start("t");
    // PRECONDITION: the job really is running, or the assertion below is vacuous
    const started = Date.now();
    while (!hasRunningBgShellsFor(dir, "bgstop") && Date.now() - started < 8000) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(
      hasRunningBgShellsFor(dir, "bgstop"),
      "precondition: the background shell must be running before the stop",
    );

    agent.stop("operator pressed stop");
    // the kill is synchronous inside stop(); give the process table a moment to agree
    const t0 = Date.now();
    while (hasRunningBgShellsFor(dir, "bgstop") && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(
      hasRunningBgShellsFor(dir, "bgstop"),
      false,
      "stop() must end the background shell — otherwise the operator's stop visibly does nothing",
    );
  } finally {
    agent.stop("end");
    await Promise.race([agent.settled().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
    await agent.dispose().catch(() => {});
  }
});
