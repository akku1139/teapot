/**
 * #120 — "a `wait_children` row does not reach 'complete' when a message is sent
 * during the wait; going through an API reload (e.g. viewing another session and
 * coming back) DOES complete it."
 *
 * The report's second half is the diagnostic: a reload re-reads the log, so the
 * row completes. That means the log is fine and the LIVE path is not — the row
 * was never re-rendered with a result it had.
 *
 * ## What this test establishes
 *
 * I could not reproduce the failure on the agent side. Driving the exact scenario
 * — park, then send a prompt — the `tool_result` is logged within ~50ms and the
 * agent reports `live:false` immediately, which is what the timeline's
 * `staleDone` guard (`!agentActive && !res`) needs to mark the row done.
 *
 * Two harness faults nearly produced a false "reproduction" first, and both are
 * worth recording:
 *
 *   1. `subAgents.list()` returning `[]` short-circuits `waitChildren` BEFORE the
 *      park ("no live sub-agents to wait for"), so nothing parked at all;
 *   2. replacing `toolCtx.signal` after `init()` gave the stub a DIFFERENT
 *      AbortController from the one `enqueuePrompt` aborts — so the wait never
 *      woke, and the row legitimately had no result.
 *
 * (2) is the interesting one: it looks exactly like the reported bug. The stub
 * has to listen on `a.toolCtx.signal` itself, the way master.ts does.
 *
 * So this pins the route that works and documents the harness requirement, rather
 * than asserting a fix for something I could not break. If the report's DOM can
 * be captured, the remaining gap is in the UI projection, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { readFileSync } from "node:fs";

/**
 * Park the agent in wait_children with ONE live child, then send a prompt.
 *
 * The stub MUST listen on `a.toolCtx.signal`: master.ts passes exactly that
 * signal to waitChildren, and `enqueuePrompt` aborts `this.toolAbort` and
 * republishes it. A stub on its own controller never wakes, which mimics the
 * reported bug without being it.
 */
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
    // a LIVE child: an empty list makes waitChildren short-circuit BEFORE parking
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
        // the agent's OWN signal — see the note above
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
  // this is what the timeline's `staleDone = !agentActive && !res` guard needs;
  // a reload "fixes" the row because it re-reads the log, which is why the
  // report saw the reload path succeed
  await useTempDirs(["t120c-", "t120d-"], async ([ws, sd]) => {
    const r = await parkThenPrompt(ws!, sd!);
    assert.equal(r.live, false, `the agent must report idle after the prompt (#120); live=${r.live}`);
  });
});

test("a parked agent IS live, so its rows are not stale (#120)", async () => {
  // The precondition that makes the bug possible: while parked, `isLive()` is
  // true (isLive() counts parkedByTool), so an unresolved row is NOT marked
  // stale. If that ever stopped holding, a row mid-park would read "done" while
  // the wait was still running.
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

test("the timeline's stale-run guard is what a reload relies on (#120)", () => {
  // structural: the reload path works because it re-reads the log, so the guard
  // must exist for a missed live event to recover at all
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  assert.match(
    app,
    /const staleDone = !props\.agentActive && !res;/,
    "an unresolved row must read done once the agent is not live (#120)",
  );
});
