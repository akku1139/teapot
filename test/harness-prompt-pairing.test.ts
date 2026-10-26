import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { readEvents } from "../src/log/events.ts";
import { Agent } from "../src/agent/agent.ts";

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
    const msgs = () => (agent as unknown as { messages: unknown[] }).messages;
    for (let i = 0; i < 900 && msgs().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    let harnessPrompts: { name: string; seq: number }[] = [];
    for (let i = 0; i < 900; i++) {
      const ev = await readEvents(agent.log.filePath);
      harnessPrompts = ev
        .filter((e) => e.type === "prompt" && (e.data as { source?: string }).source === "harness")
        .map((e) => ({ name: String((e.data as { text?: string }).text ?? "").slice(0, 40), seq: e.seq }));
      if (harnessPrompts.length >= 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(
      harnessPrompts.length >= 1,
      "precondition: the harness must have sent at least one prompt (#95)",
    );
    const log = await readEvents(agent.log.filePath);
    let prevWasHarness = false;
    const pairs: string[] = [];
    for (const e of log) {
      if (e.type === "message") {
        prevWasHarness = false; 
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
      if (sawSuppression && turns > 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const events = await readEvents(agent.log.filePath);
    const text = (e: { data?: unknown }) => (e.data ?? {}) as Record<string, unknown>;

    assert.ok(
      events.some((e) => e.type === "prompt" && String(text(e).text ?? "").includes("progress report")),
      "precondition: a progress request must have been issued",
    );
    assert.ok(
      sawSuppression,
      "precondition: the suppression branch must have been reached (a progress request and a round end in the same round)",
    );

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
