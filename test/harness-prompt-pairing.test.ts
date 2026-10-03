/**
 * #95 — "two harness messages arrive consecutively."
 *
 * Reproduced from the report and measured: with the progress gates open, the
 * model received SIX pairs like this, alternating forever:
 *
 *     [harness] Please give a brief progress report now: what you are doing…
 *     Continue working toward the current goal. If you are blocked…
 *
 * Both are injected by the HARNESS at the same turn boundary — `maybeRequestProgress`
 * is inside the turn loop, and the auto-continue nudge is pushed after the round
 * ends. Both append a `user` message, so the model saw two instructions back to
 * back that also read as the harness contradicting itself: "keep going" followed
 * immediately by "report your progress now".
 *
 * The progress request already re-enters the loop, so it IS the continuation.
 * Suppressing the nudge when one is pending costs nothing and leaves exactly one
 * instruction per boundary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

/** build an agent whose progress gates always fire, so both prompts want to run */
function noisy(ws: string, sd: string) {
  return new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => ({
      message: { role: "assistant" as const, content: "working " + "y".repeat(3000) },
    }),
    autoContinue: true,
    autoCompact: false,
    progressIntervalMs: 0,
    progressMinChars: 0,
    progressMaxQuietTurns: 1,
    continueDelayMs: 1,
    maxTurns: 2,
  } as never) as Agent;
}

const isHarness = (t: string) => t.includes("[harness]") || t.startsWith("Continue working toward");

/** the longest run of consecutive harness user messages */
function worstRun(messages: readonly unknown[]): number {
  let run = 0;
  let worst = 0;
  for (const m of messages as { role?: string; content?: string }[]) {
    if (m.role !== "user") {
      run = 0;
      continue;
    }
    if (isHarness(String(m.content ?? ""))) {
      run++;
      worst = Math.max(worst, run);
    }
  }
  return worst;
}

test("the harness never sends two prompts back to back (#95)", { timeout: 30_000 }, async () => {
  await useTempDirs(["h95a-", "h95b-"], async ([ws, sd]) => {
    const agent = noisy(ws!, sd!);
    await agent.init();
    await agent.setGoal("keep going");
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    // Bounded: with the suppression removed the agent pairs prompts forever, so
    // an unbounded wait would hang the suite instead of failing it.
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(
      (agent as unknown as { messages: unknown[] }).messages.length > 0,
      "precondition: the agent must have run (#95)",
    );
    assert.equal(
      worstRun((agent as unknown as { messages: unknown[] }).messages),
      1,
      "two consecutive harness prompts read as the harness contradicting itself (#95)",
    );
    await agent.dispose();
  });
});

test("the suppression is recorded in the log (#95)", { timeout: 30_000 }, async () => {
  await useTempDirs(["h95e-", "h95f-"], async ([ws, sd]) => {
    const agent = noisy(ws!, sd!);
    await agent.init();
    await agent.setGoal("keep going");
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    // Bounded: with the suppression removed the agent pairs prompts forever, so
    // an unbounded wait would hang the suite instead of failing it.
    await new Promise((r) => setTimeout(r, 300));
    const { readEvents } = await import("../src/log/events.ts");
    const events = await readEvents(agent.log.filePath);
    const notes = events.filter(
      (e) =>
        e.type === "system_note" &&
        (e.data as { event?: string })?.event === "auto-continue-suppressed",
    );
    assert.ok(
      notes.length > 0,
      "the suppressed nudge must be recorded (#95) — otherwise it looks like auto-continue broke",
    );
    assert.match(
      String((notes[0]!.data as { detail?: string }).detail ?? ""),
      /progress report/i,
      "and must say why (#95)",
    );
    await agent.dispose();
  });
});
