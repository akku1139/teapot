import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("runs POSIX commands through the bash tool");

interface Ev {
  type: string;
  data?: Record<string, unknown>;
}

function talkOnly() {
  let n = 0;
  return async () => {
    n++;
    return { message: { role: "assistant" as const, content: `still talking #${n}` } };
  };
}

function toolSpinner() {
  let n = 0;
  return async () => {
    n++;
    return {
      message: {
        role: "assistant" as const,
        content: "",
        tool_calls: [
          {
            id: `c${n}`,
            type: "function" as const,
            function: { name: "bash", arguments: JSON.stringify({ command: "echo x" }) },
          },
        ],
      },
    };
  };
}

test("a talk-only model is stopped instead of spinning forever (#106)", async () => {
  await useTempDirs(["t106a-", "t106b-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: talkOnly() as never,
      autoContinue: true,
      continueDelayMs: 0,
      maxConsecutiveIdleRounds: 6,
    } as never) as Agent;
    await a.init();
    await a.setGoal("keep talking");
    a.enqueuePrompt("talk to me", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 3000));
    const events = (await readEvents(a.log.filePath)) as Ev[];
    a.stop("test done");
    await a.settled();
    const bounded = events.some(
      (e) => e.type === "system_note" && e.data?.event === "auto-continue-bounded",
    );
    const turns = events.filter(
      (e) => e.type === "message" && e.data?.role === "assistant",
    ).length;
    console.log(`  turns=${turns} bounded=${bounded}`);
    assert.ok(
      bounded,
      "the idle-round valve must fire for a model that never acts (#106)",
    );
    assert.equal(
      turns,
      7,
      `a cap of 6 must allow exactly 7 rounds — the valve fires on exceeding it (#106/#141); got ${turns}`,
    );
  });
});

test("a model that keeps calling tools is NEVER bounded by the valve (#106)", async () => {
  await useTempDirs(["t106c-", "t106d-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: toolSpinner() as never,
      autoContinue: true,
      continueDelayMs: 0,
      maxConsecutiveIdleRounds: 3,
      maxTurnsPerRound: 40,
    } as never) as Agent;
    await a.init();
    await a.setGoal("keep working");
    a.enqueuePrompt("work", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 3000));
    const events = (await readEvents(a.log.filePath)) as Ev[];
    const bounded = events.some(
      (e) => e.type === "system_note" && e.data?.event === "auto-continue-bounded",
    );
    const turns = a.stats.turns;
    a.stop("test done");
    await a.settled();
    console.log(`  tool-using model: turns=${turns} bounded=${bounded}`);
    assert.equal(bounded, false, "a working model must never hit the idle valve (#106)");
  });
});

test("the per-round cap still fires for a tool-using model (#106)", async () => {
  await useTempDirs(["t106e-", "t106f-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: toolSpinner() as never,
      autoContinue: false,
      maxTurnsPerRound: 8,
    } as never) as Agent;
    await a.init();
    await a.setGoal("spin");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 2500));
    const events = (await readEvents(a.log.filePath)) as Ev[];
    const caps = events.filter(
      (e) => e.type === "system_note" && e.data?.event === "round-turn-cap",
    ).length;
    a.stop("done");
    await a.settled();
    console.log(`  per-round cap notes=${caps}`);
    assert.ok(caps >= 1, `the per-round cap must still fire (#106); got ${caps}`);
  });
});

test("a model that finishes properly is unaffected (#106)", async () => {
  await useTempDirs(["t106g-", "t106h-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            {
              id: "f1",
              type: "function" as const,
              function: { name: "finish", arguments: JSON.stringify({ goalComplete: true, summary: "done" }) },
            },
          ],
        },
      }),
      autoContinue: false,
      maxTurnsPerRound: 5,
      maxConsecutiveIdleRounds: 3,
    } as never) as Agent;
    await a.init();
    await a.setGoal("finish promptly");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await a.settled();
    await a.dispose();
    assert.equal(a.goal.status, "done", "the goal must still complete (#106)");
  });
});
