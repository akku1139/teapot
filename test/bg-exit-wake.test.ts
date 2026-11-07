import test from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const reply = (content: string): LlmResult => ({ message: { role: "assistant", content } });

const make = (ws: string, sd: string, turns: { n: number; seen: string[] }) =>
  new Agent({
    id: "w",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (_c: unknown, messages: any): Promise<LlmResult> => {
      turns.n += 1;
      const all = Array.isArray(messages) ? messages.map((m: any) => String(m.content ?? "")).join("\n") : "";
      if (/Background job report/.test(all)) turns.seen.push("report");
      return reply("nothing to do");
    },
    autoContinue: false,
  } as never) as InstanceType<typeof Agent>;

const exitEvent = { id: "bg99", code: 0, cmd: "sleep 1 && echo done", durationMs: 1000, outputTail: "done" };

test("a finished goal IS told about a background job — that is news, not a loop", async () => {
  /**
   * "goal doneで通知しないのは違うのでは? / エージェントにも通知されてない". Suppressing the wake for a finished goal
   * silenced the completion entirely. The guard belongs on the CONTENT instead: a round starts because there is an
   * undrained exit to report.
   */
  await useTempDirs(["bge-a-", "bge-b-"], async ([ws, sd]) => {
    const turns = { n: 0, seen: [] as string[] };
    const a = make(ws!, sd!, turns);
    try {
      await a.init();
      await a.load();
      await a.setGoal("finish the work");
      await a.setGoalStatus("done", "operator");
      (a as unknown as { onBackgroundJobExitQueued: (i: unknown) => void }).onBackgroundJobExitQueued(exitEvent);
      const deadline = Date.now() + 5_000;
      while (turns.n === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.ok(turns.n >= 1, "the finished goal must still be woken by a completed job");
      assert.ok(turns.seen.includes("report"), "and the round must actually carry the report");
    } finally {
      await a.dispose().catch(() => {});
    }
  });
});

test("an exit that the running round already drained does not start an EMPTY round", async () => {
  /**
   * The amplification: an exit arriving mid-round scheduled a wake anyway, and by the time it ran the running round had
   * drained it — eleven rounds in mediapad-t5, none of them with a report ("こいつなんで終了時にループしてんの?").
   */
  await useTempDirs(["bge-c-", "bge-d-"], async ([ws, sd]) => {
    const turns = { n: 0, seen: [] as string[] };
    const a = make(ws!, sd!, turns);
    const internals = a as unknown as {
      status: string;
      drainBackgroundExits: () => void;
      onBackgroundJobExitQueued: (i: unknown) => void;
      settled: () => Promise<void>;
    };
    try {
      await a.init();
      await a.load();
      await a.setGoal("watch a job");
      // what a round in flight looks like: the exit arrives while running, and that round consumes it
      internals.status = "running";
      internals.onBackgroundJobExitQueued(exitEvent);
      internals.drainBackgroundExits(); // the in-flight round drains it
      internals.status = "idle";
      await internals.settled();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(turns.n, 0, "nothing left to report means no round at all");
    } finally {
      await a.dispose().catch(() => {});
    }
  });
});

test("a FAILED job wakes even a finished goal", async () => {
  await useTempDirs(["bge-e-", "bge-f-"], async ([ws, sd]) => {
    const turns = { n: 0, seen: [] as string[] };
    const a = make(ws!, sd!, turns);
    try {
      await a.init();
      await a.load();
      await a.setGoal("finish the work");
      await a.setGoalStatus("done", "operator");
      (a as unknown as { onBackgroundJobExitQueued: (i: unknown) => void }).onBackgroundJobExitQueued({
        ...exitEvent,
        id: "bg98",
        code: 2,
      });
      const deadline = Date.now() + 5_000;
      while (turns.n === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.ok(turns.n >= 1, "a failing job must reach the agent");
    } finally {
      await a.dispose().catch(() => {});
    }
  });
});
