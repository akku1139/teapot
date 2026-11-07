import test from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const reply = (content: string): LlmResult => ({ message: { role: "assistant", content } });

const make = (ws: string, sd: string, turns: { n: number }) =>
  new Agent({
    id: "w",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (): Promise<LlmResult> => {
      turns.n += 1;
      return reply("nothing to do");
    },
    autoContinue: false,
  } as never) as InstanceType<typeof Agent>;

const exitEvent = { id: "bg99", code: 0, cmd: "sleep 1 && echo done", durationMs: 1000, outputTail: "done" };

test("a finished goal is not woken again by a background exit", async () => {
  /**
   * MEASURED on mediapad-t5-root-attempt-2: after the finish was accepted, eleven background jobs (bg32…bg42) exited
   * one after another and each one started a round that answered "完了済みです。追加の作業はありません。" and stopped —
   * which the operator read, correctly, as a loop at shutdown ("こいつなんで終了時にループしてんの?").
   */
  await useTempDirs(["bge-a-", "bge-b-"], async ([ws, sd]) => {
    const turns = { n: 0 };
    const a = make(ws!, sd!, turns);
    try {
      await a.init();
      await a.load(); // → idle, which is the state a running session is woken from
      await a.setGoal("finish the work");
      await a.setGoalStatus("done", "operator");
      (a as unknown as { onBackgroundJobExitQueued: (i: unknown) => void }).onBackgroundJobExitQueued(exitEvent);
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(turns.n, 0, "a done goal must not be restarted by a leftover job");
      // …and the result is NOT lost: it is waiting for the next round the operator starts
      assert.equal((a.snapshot() as { bgRunning?: number }).bgRunning ?? 0, 0);
    } finally {
      await a.dispose().catch(() => {});
    }
  });
});

test("an ACTIVE goal is still woken by a background exit", async () => {
  await useTempDirs(["bge-c-", "bge-d-"], async ([ws, sd]) => {
    const turns = { n: 0 };
    const a = make(ws!, sd!, turns);
    try {
      await a.init();
      await a.load();
      await a.setGoal("finish the work");
      (a as unknown as { onBackgroundJobExitQueued: (i: unknown) => void }).onBackgroundJobExitQueued(exitEvent);
      const deadline = Date.now() + 5_000;
      while (turns.n === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.ok(turns.n >= 1, "the unfinished goal must see the job it was waiting for");
    } finally {
      await a.dispose().catch(() => {});
    }
  });
});
