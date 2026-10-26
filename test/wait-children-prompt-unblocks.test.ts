import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

async function parkThenPrompt(ws: string, sd: string) {
  let turn = 0;
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
  await a.init();
  await a.setGoal("g");

  const kid = { id: "kid", status: "running" };
  let parked = false;
  (a as unknown as { toolCtx: Record<string, unknown> }).toolCtx.subAgents = {
    list: () => [kid],
    spawn: async () => ({ id: "x" }),
    message: async () => {},
    kill: async () => {},
    wait: () =>
      new Promise((res) => {
        parked = true;
        const t = setInterval(() => {}, 50);
        const done = (note: string) => {
          clearInterval(t);
          res({ note });
        };
        const sig = (a as unknown as { toolCtx: { signal: AbortSignal } }).toolCtx.signal;
        sig.addEventListener("abort", () => done("aborted while waiting"), { once: true });
      }),
  };

  a.enqueuePrompt("go", "user");
  a.start("t");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(parked, true, "the agent must actually be parked (#120)");
  assert.equal(
    (a as unknown as { parkedByTool: boolean }).parkedByTool,
    true,
    "and flagged as parked (#120)",
  );

  a.enqueuePrompt("are you there?", "user");
  await new Promise((r) => setTimeout(r, 700));
  const events = await readEvents(`${sd}/chat.jsonl`);
  return {
    parked,
    live: a.snapshot().live ?? false,
    results: events.filter((e) => e.type === "tool_result").length,
    calls: events.filter((e) => e.type === "tool_call").length,
  };
}

test("a prompt during wait_children resolves the row (#120)", async () => {
  await useTempDirs(["t120a-", "t120b-"], async ([ws, sd]) => {
    const r = await parkThenPrompt(ws!, sd!);
    assert.equal(r.calls, 1, "precondition: the call was logged (#120)");
    assert.equal(
      r.results,
      1,
      `a prompt during the park must produce a tool_result (#120); got ${r.results}`,
    );
  });
});

test("the agent stops being live once the prompt takes over (#120)", async () => {
  await useTempDirs(["t120c-", "t120d-"], async ([ws, sd]) => {
    const r = await parkThenPrompt(ws!, sd!);
    assert.equal(r.live, false, `the agent must report idle after the prompt (#120); live=${r.live}`);
  });
});

test("a parked agent IS live, so its rows are not stale (#120)", async () => {
  await useTempDirs(["t120e-", "t120f-"], async ([ws, sd]) => {
    let calls = 0;
    const a = new Agent({
      id: "p",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        calls++;
        return calls === 1
          ? {
              message: {
                role: "assistant" as const,
                content: "",
                tool_calls: [
                  { id: "w", type: "function" as const, function: { name: "wait_children", arguments: "{}" } },
                ],
              },
            }
          : { message: { role: "assistant" as const, content: "ok" } };
      },
      autoContinue: false,
    } as never) as Agent;
    await a.init();
    await a.setGoal("g");
    let parked = false;
    (a as unknown as { toolCtx: Record<string, unknown> }).toolCtx.subAgents = {
      list: () => [{ id: "kid", status: "running" }],
      spawn: async () => ({ id: "x" }),
      message: async () => {},
      kill: async () => {},
      wait: () =>
        new Promise((res) => {
          parked = true;
          const t = setInterval(() => {}, 50);
          const sig = (a as unknown as { toolCtx: { signal: AbortSignal } }).toolCtx.signal;
          sig.addEventListener("abort", () => {
            clearInterval(t);
            res({ note: "aborted" });
          }, { once: true });
        }),
    };
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(parked, true, "precondition: it parked (#120)");
    assert.equal(
      a.snapshot().live,
      true,
      "a parked agent must read live, or staleDone would mis-mark a row still in flight (#120)",
    );
    a.stop("end");
    await a.settled();
  });
});
