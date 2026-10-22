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
import { readEvents } from "../src/log/events.ts";
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
    /**
     * POLL until the round boundary that the bug happens AT, do not sleep.
     *
     * A fixed 300ms was the whole precondition, and it failed on the Windows runner with `0 !== 1`
     * — the agent had not got far enough. AGENTS.md names this failure: on a loaded runner a fixed
     * duration expires as "precondition not met" with nothing to say the test merely ran out of
     * clock.
     *
     * Bounded as before — with the suppression removed the agent pairs prompts forever, and an
     * unbounded wait would hang the suite instead of failing it.
     */
    const msgs = () => (agent as unknown as { messages: unknown[] }).messages;
    /**
     * Wait for the RUN TO END, not for a message count.
     *
     * MEASURED with the suppression disabled: the agent has 61 messages at 50ms and 204 by 150ms,
     * then stops. So any "poll until N messages" condition is satisfied long before the pairing
     * this test exists to catch has happened — a first attempt at fixing the flake that way made
     * the test pass with the bug present, i.e. vacuous. `maxTurns: 2` bounds the run, so "not
     * running any more" is the state where the message list is final.
     */
    /**
     * Poll on the MESSAGE COUNT SETTLING, not on `status`.
     *
     * `start()` returns before the loop flips status to `running` (MEASURED: it is still
     * `stopped` on the line after `start("t")`), so `while (status === "running")` exits
     * immediately and the test then asserts on an empty list — it failed with "precondition: the
     * agent must have run" for exactly that reason. The observable signal is the list growing and
     * then stopping: `maxTurns: 2` guarantees it stops.
     */
    /**
     * Poll until the run has BOTH produced messages AND stopped producing them.
     *
     * "Unchanged across two polls" alone was not enough: on a loaded Windows runner the loop
     * entered before the agent had done anything, saw 0 then 0, and concluded the run was over —
     * so the assertion ran against an empty list and failed with `0 !== 1` while the product was
     * fine. MEASURED locally: 61 messages by 50ms, 204 by 150ms. The settle check therefore needs
     * a minimum progress first, and a run that never starts must surface as the precondition
     * failing rather than as a wrong answer about pairing.
     */
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 600; i++) {
      const n = msgs().length;
      if (n > 0 && n === last) {
        // require several consecutive identical readings, not just one, so a pause between
        // rounds on a slow machine is not mistaken for the end of the run
        if (++stable >= 5) break;
      } else {
        stable = 0;
      }
      last = n;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(
      msgs().length > 0,
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


test("a progress request does not END the round's work (#95)", { timeout: 30_000 }, async () => {
  /**
   * MEASURED in session tyb2-8-0161a4af (seq 18778-18780): `maybeRequestProgress` runs its own
   * `llmCall` at the top of the turn, so the assistant message it produces is a progress REPORT.
   * The round then ended, the suppression branch saw the flag and BROKE — leaving the agent idle
   * with the work unfinished and no nudge ever sent again.
   *
   * "何故 auto-continue が効いてない?" was the operator's question; the log held exactly one
   * `auto-continue-suppressed` note, at the very end. That is the signature: suppressing the
   * paired nudge is right (one instruction per boundary), breaking the loop is not.
   */
  await useTempDirs(["h95g-", "h95h-"], async ([ws, sd]) => {
    const agent = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({
        message: { role: "assistant" as const, content: "working " + "y".repeat(3000) },
      }),
      autoContinue: true,
      autoCompact: false,
      // fire a progress request on the FIRST boundary, which is what the report hit
      progressIntervalMs: 0,
      progressMinChars: 0,
      progressMaxQuietTurns: 0,
      continueDelayMs: 1,
      maxTurns: 6,
    } as never) as Agent;
    await agent.init();
    await agent.setGoal("keep going");
    agent.enqueuePrompt("go", "user");
    agent.start("t");

    /**
     * Poll for the EVENT this test is about, not for the message list to settle.
     *
     * The suppression note is written only when a progress request and a round end land in the same
     * round. On the Windows runner that ordering is slower, so the list appeared to settle before
     * it happened and the precondition failed — a timing assumption, not a product problem.
     *
     * Bounded, and the bound is the point: with the suppression removed the note never appears at
     * all, so the loop must exit and let the precondition fail rather than hang.
     */
    let sawSuppression = false;
    for (let i = 0; i < 600; i++) {
      const ev = await readEvents(agent.log.filePath);
      if (
        ev.some(
          (e) =>
            e.type === "system_note" &&
            (e.data as { event?: string }).event === "auto-continue-suppressed",
        )
      ) {
        sawSuppression = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    // stop the loop before reading the log, so the turn count below is final
    (agent as unknown as { stopRequested: boolean }).stopRequested = true;

    const events = await readEvents(agent.log.filePath);
    const text = (e: { data?: unknown }) => (e.data ?? {}) as Record<string, unknown>;

    // PRECONDITIONS — without both, the assertion below would pass for the wrong reason
    assert.ok(
      events.some((e) => e.type === "prompt" && String(text(e).text ?? "").includes("progress report")),
      "precondition: a progress request must have been issued",
    );
    assert.ok(
      sawSuppression,
      "precondition: the suppression branch must have been reached (a progress request and a round end in the same round)",
    );

    /**
     * …and the work must CONTINUE. Counting turns rather than asserting a status, because
     * `status` is mutable and the dispose below changes it: more than one turn start means the
     * loop came back after the progress round instead of parking.
     */
    const turns = events.filter(
      (e) => e.type === "state" && text(e).detail === "llm turn start",
    ).length;
    assert.ok(
      turns > 1,
      `the agent must continue past a progress report; saw ${turns} turn(s) — 1 means the suppression broke the loop`,
    );
    await agent.dispose();
  });
});
