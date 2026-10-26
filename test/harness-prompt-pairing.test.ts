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
     * Wait for the run to END — `status` leaves "running" — not for the message count to look
     * settled.
     *
     * A count-based settle is wrong in principle here: `worstRun` reads ADJACENCY, and mid-run
     * there is a legitimate instant where a harness prompt has been pushed and the assistant reply
     * that separates it has not. MEASURED on the Windows runner: the polls looked stable for five
     * consecutive reads at ~406ms into a run that was still going, and the test failed with
     * "two consecutive harness prompts" while the product was fine.
     *
     * `maxTurns: 2` bounds the run, so waiting for it to finish is bounded too. The lower bound on
     * progress is kept: a run that never starts must fail the PRECONDITION, not the pairing
     * assertion.
     */
    for (let i = 0; i < 900 && msgs().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    /**
     * `status` cannot be polled for "running" — `start()` returns BEFORE the loop flips it (it is
     * still `stopped` on the next line), so that loop exits immediately. The LOG is the observable:
     * `maxTurns: 2` guarantees the run ends, and the agent writes a state row when it returns to
     * idle. Waiting for that is waiting for the run to actually finish.
     */
    /**
     * Assert on the LOG, not on the in-memory message list.
     *
     * The log is append-only and records every harness prompt with `source: "harness"`, so
     * "two harness prompts with no assistant turn between them" is directly observable there. The
     * in-memory list needed a "has the run finished?" poll, and every version of that poll I tried
     * was satisfiable before the pairing had happened — MEASURED: with the suppression disabled the
     * test still passed (it had become vacuous), because a bare "idle row exists" check matched the
     * startup transition and the loop broke in 21ms.
     *
     * Bounded wait on harness prompts: with the suppression working there are few, and with it
     * broken the pairing appears immediately, so this terminates either way.
     */
    let harnessPrompts: { name: string; seq: number }[] = [];
    for (let i = 0; i < 900; i++) {
      const ev = await readEvents(agent.log.filePath);
      harnessPrompts = ev
        .filter((e) => e.type === "prompt" && (e.data as { source?: string }).source === "harness")
        .map((e) => ({ name: String((e.data as { text?: string }).text ?? "").slice(0, 40), seq: e.seq }));
      if (harnessPrompts.length >= 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // PRECONDITION: the run must have produced at least one harness prompt to reason about
    assert.ok(
      harnessPrompts.length >= 1,
      "precondition: the harness must have sent at least one prompt (#95)",
    );
    /**
     * The signal is ADJACENCY, not a count.
     *
     * Counting harness prompts cannot work: with the gates open the agent legitimately requests
     * progress several times (MEASURED: 5 in one short run, all progress reports). The bug is two
     * harness prompts with NO assistant message between them, which is what reads to the model as
     * the harness contradicting itself.
     *
     * Read from the log, so the ordering is the file's own and there is no window to miss.
     */
    const log = await readEvents(agent.log.filePath);
    let prevWasHarness = false;
    const pairs: string[] = [];
    for (const e of log) {
      if (e.type === "message") {
        prevWasHarness = false; // an assistant turn separates instructions
        continue;
      }
      if (e.type !== "prompt") continue;
      const isHarness = (e.data as { source?: string }).source === "harness";
      if (isHarness && prevWasHarness) {
        pairs.push(String((e.data as { text?: string }).text ?? "").slice(0, 60));
      }
      prevWasHarness = isHarness;
    }
    assert.deepEqual(
      pairs,
      [],
      "back-to-back harness prompts read as the harness contradicting itself (#95):\n" + pairs.join("\n"),
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
    /**
     * Wait for BOTH facts the test needs: the suppression happened, AND the loop came back for
     * another turn. Polling only for the first let the assertion below run against a log that had
     * one turn in it, which is indistinguishable from the bug being present.
     */
    let sawSuppression = false;
    for (let i = 0; i < 600; i++) {
      const ev = await readEvents(agent.log.filePath);
      const note = ev.some(
        (e) =>
          e.type === "system_note" &&
          (e.data as { event?: string }).event === "auto-continue-suppressed",
      );
      const turns = ev.filter(
        (e) =>
          e.type === "state" &&
          (e.data as { detail?: string }).detail === "llm turn start",
      ).length;
      if (note) sawSuppression = true;
      // the suppression is what this test injects; wait until it is followed by another turn
      if (sawSuppression && turns > 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    /**
     * Do NOT set `stopRequested` here to "freeze" the log.
     *
     * It stops the loop after the CURRENT turn, so the assertion below ("more than one turn start")
     * could never see a second one — the test then failed for its own interference rather than for
     * the bug. The turn count is instead read after `maxTurns` has had its chance, and the log is
     * append-only so counting is stable.
     */

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
