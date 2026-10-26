
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hangingWait(a: Agent, mark: () => void) {
  return () => {
    mark();
    return new Promise((res) => {
      const t = setInterval(() => {}, 50);
      t.unref?.();
      const sig = (a as unknown as { toolCtx: { signal: AbortSignal } }).toolCtx.signal;
      sig.addEventListener("abort", () => {
        clearInterval(t);
        res({ note: "aborted while waiting" });
      }, { once: true });
    });
  };
}

test("a prompt queued BEFORE wait_children takes priority over the park (#140)", async () => {
  await useTempDirs(["t140a-", "t140b-"], async ([ws, sd]) => {
    let turn = 0;
    let agent: Agent | null = null;
    let waitCalled = false;
    const a = new Agent({
      id: "p",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        turn++;
        if (turn === 1) {
          agent?.enqueuePrompt("urgent operator check-in", "user");
          return {
            message: {
              role: "assistant" as const,
              content: "",
              tool_calls: [
                {
                  id: "w1",
                  type: "function" as const,
                  function: { name: "wait_children", arguments: JSON.stringify({ timeout_ms: 60000 }) },
                },
              ],
            },
          };
        }
        return { message: { role: "assistant" as const, content: `handled: ${turn}` } };
      },
      autoContinue: false,
    } as never) as Agent;
    agent = a;
    try {
      await a.init();
      await a.setGoal("g");
      (a as unknown as { toolCtx: Record<string, unknown> }).toolCtx.subAgents = {
        list: () => [{ id: "kid", status: "running" }],
        spawn: async () => ({ id: "x" }),
        message: async () => {},
        kill: async () => {},
        wait: hangingWait(a, () => {
          waitCalled = true;
        }),
      };

      a.start("t");
      await wait(500);
      assert.equal(
        waitCalled,
        false,
        "the child wait must not even START while a prompt is pending (#140)",
      );
      assert.equal(
        (a as unknown as { parkedByTool: boolean }).parkedByTool,
        false,
        "the agent must not park over a pending prompt (#140)",
      );
      await Promise.race([a.settled(), wait(3000)]);
      assert.equal(
        (a as unknown as { pendingPrompts: unknown[] }).pendingPrompts.length,
        0,
        "the pending prompt was consumed",
      );
      const events = await readEvents(a.log.filePath);
      assert.ok(
        events.some(
          (e) =>
            e.type === "system_note" &&
            (e.data as { event?: string; preview?: string }).event === "prompt-delivered" &&
            String((e.data as { preview?: string }).preview ?? "").includes("urgent operator check-in"),
        ),
        "the operator's prompt must be DELIVERED, not held hostage by the wait (#140)",
      );
    } finally {
      a.stop("end");
      await Promise.race([a.settled().catch(() => {}), wait(1000)]);
      await a.dispose().catch(() => {});
    }
  });
});

test("a prompt arriving DURING the park still wakes it (existing path, kept)", async () => {
  await useTempDirs(["t140c-", "t140d-"], async ([ws, sd]) => {
    let turn = 0;
    let waitCalled = false;
    const a = new Agent({
      id: "p",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        turn++;
        if (turn === 1)
          return {
            message: {
              role: "assistant" as const,
              content: "",
              tool_calls: [
                {
                  id: "w1",
                  type: "function" as const,
                  function: { name: "wait_children", arguments: JSON.stringify({ timeout_ms: 60000 }) },
                },
              ],
            },
          };
        return { message: { role: "assistant" as const, content: "ok" } };
      },
      autoContinue: false,
    } as never) as Agent;
    try {
      await a.init();
      await a.setGoal("g");
      (a as unknown as { toolCtx: Record<string, unknown> }).toolCtx.subAgents = {
        list: () => [{ id: "kid", status: "running" }],
        spawn: async () => ({ id: "x" }),
        message: async () => {},
        kill: async () => {},
        wait: hangingWait(a, () => {
          waitCalled = true;
        }),
      };
      a.enqueuePrompt("go", "user"); 
      a.start("t");
      await wait(400);
      assert.equal(waitCalled, true, "precondition: the park happened (no prompt was pending)");
      a.enqueuePrompt("are you there?", "user");
      await Promise.race([a.settled(), wait(3000)]);
      assert.equal(waitCalled, true, "#140 kept: a mid-park prompt wakes the wait");
    } finally {
      a.stop("end");
      await Promise.race([a.settled().catch(() => {}), wait(1000)]);
      await a.dispose().catch(() => {});
    }
  });
});
