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
    const started = Date.now();
    while (!hasRunningBgShellsFor(dir, "bgstop") && Date.now() - started < 8000) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(
      hasRunningBgShellsFor(dir, "bgstop"),
      "precondition: the background shell must be running before the stop",
    );

    agent.stop("operator pressed stop");
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
