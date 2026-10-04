/**
 * #106 — `maxTurnsPerRound` cannot bound a model that only TALKS.
 *
 * The cap is evaluated once a round ENDS, and it is per-round. But a ROOT agent
 * that answers with a bare message leaves its round after ONE turn
 * (`return finished` in `runTurnsUntilIdle`), so:
 *
 *   - `stats.turns - turnsAtStart` is always 1, and
 *   - no single round ever reaches the cap.
 *
 * `finished` stays false, the goal stays active, and auto-continue starts the next
 * round — forever. Measured before the fix: `maxTurnsPerRound = 40` produced 997
 * turns and ZERO `round-turn-cap` notes.
 *
 * A tool-calling model is unaffected and does trip the cap (measured: 8 turns, 1
 * note), which is how the gap was localised to the talk-only shape.
 *
 * The fix bounds CONSECUTIVE rounds that neither call a tool nor finish, which is
 * where the real loop lives. It is a safety valve, deliberately generous: any
 * tool call resets the counter, so a long autonomous stretch that keeps acting is
 * never affected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// #110: POSIX-only — runs POSIX commands through the bash tool.
// The Windows CI job skips this file; see test/helpers/posix-only.ts for why
// opting out is explicit rather than by filename.
markPosixOnly("runs POSIX commands through the bash tool");

interface Ev {
  type: string;
  data?: Record<string, unknown>;
}

/** a model that answers every turn with prose and never calls a tool */
function talkOnly() {
  let n = 0;
  return async () => {
    n++;
    return { message: { role: "assistant" as const, content: `still talking #${n}` } };
  };
}

/** a model that calls a tool every turn */
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
    // Count real turns from the LOG, not `stats.turns`: that counter only ticks
    // from a bus event, so for a talk-only round it reports 1 however many LLM
    // calls actually happened — which is exactly how the original bug hid.
    const turns = events.filter(
      (e) => e.type === "message" && e.data?.role === "assistant",
    ).length;
    console.log(`  turns=${turns} bounded=${bounded}`);
    assert.ok(
      bounded,
      "the idle-round valve must fire for a model that never acts (#106)",
    );
    assert.ok(
      turns <= 12,
      `turns must stay near the valve, got ${turns} for a cap of 6 (#106)`,
    );
  });
});

test("a model that keeps calling tools is NEVER bounded by the valve (#106)", async () => {
  // the important non-regression: real work must not be capped
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
  // the cap that already worked must keep working
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
