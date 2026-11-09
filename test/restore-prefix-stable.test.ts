/**
 * Restoring a session must rebuild EXACTLY the conversation the model last saw (#227).
 *
 * The worry behind the issue ("chat.jsonlみてて不安になった") is the prefix cache: if a restore re-invents any part of the
 * prompt — a harness message with a fresh timestamp, a counter, a summarised notice with new numbers — the cached prefix
 * is invalidated and the operator pays full price for the whole conversation on the next turn.
 *
 * So the contract is byte equality: capture `messages` before the restart, restore twice, and compare.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

async function make(ws: string, sd: string, chatFn: () => Promise<LlmResult>, load = false) {
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn,
    contextTokenBudget: 900,
    autoContinue: false,
    // what `Master.addAgent` passes for a booted agent — without it `ensureReady()` does not restore at all
    restoreSession: true,
  } as never) as InstanceType<typeof Agent>;
  await a.init();
  // `init()` only wires the lazy `ensureReady()`; `load()` is what actually restores the session
  if (load) await a.load();
  return a;
}

test("a restored conversation is byte-identical to the one that was running", async () => {
  await useTempDirs(["rp-", "rp-sd-"], async ([ws, sd]) => {
    let n = 0;
    const fn = async (): Promise<LlmResult> => {
      n += 1;
      if (n === 1) return { message: { role: "assistant", content: "", tool_calls: [tc("c1", "write_file", { path: "a.txt", content: "x".repeat(900) })] } };
      return { message: { role: "assistant", content: `reply ${n} ${"y".repeat(600)}` } };
    };
    const first = await make(ws!, sd!, fn);
    first.enqueuePrompt("start the work", "user");
    first.start("t");
    await first.settled();
    const before = JSON.stringify(first.conversation);
    first.stop("done");

    const second = await make(ws!, sd!, async () => ({ message: { role: "assistant", content: "unused" } }), true);
    try {
      const after1 = JSON.stringify(second.conversation);
      assert.equal(after1, before, "the rebuilt conversation must match what the model saw, or the prefix cache dies");

      second.stop("done");
      const third = await make(ws!, sd!, async () => ({ message: { role: "assistant", content: "unused" } }), true);
      try {
        const after2 = JSON.stringify(third.conversation);
        assert.equal(after2, after1, "and a SECOND restore must not grow or change it either");
      } finally {
        third.stop("done");
      }
    } finally {
      second.stop("done");
    }
  });
});
