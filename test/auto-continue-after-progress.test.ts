import assert from "node:assert/strict";
import test from "node:test";
import { useTempDirs } from "./helpers/tmp.ts";
import { readEvents } from "../src/log/events.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const dataOf = (e: { data?: unknown }) => (e.data ?? {}) as Record<string, unknown>;
const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (content: string, calls?: ReturnType<typeof tc>[]): LlmResult => ({
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
});

test("a report followed by 'reported.' continues the loop — with NO goal set (#215)", async () => {
  /**
   * "progress report後は強制的にauto-continueする / `reported.` で止まるケースが多すぎる".
   *
   * The prompt tells the model to end the turn right after filing a report, so it files one, answers "reported." and
   * stops with the work unfinished. The forced continue is placed BEFORE the goal/auto-continue check on purpose, so
   * it also covers an agent with no goal — the harness asks for progress after real activity, and the operator's
   * message is what defines the task then.
   */
  await useTempDirs(["ac215a-", "ac215b-"], async ([ws, sd]) => {
    let calls = 0;
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => {
        calls += 1;
        if (calls === 1)
          return reply("", [tc("p1", "report_progress", { doing: "x", goalStatus: "y", recent: "z" })]);
        if (calls === 2) return reply("reported.");
        return reply("", [tc("f1", "finish", { goalComplete: false, summary: "no reachable blocker: ran out of time" })]);
      },
      // deliberately OFF, and no goal: the point is that a report forces the continue on its own
      autoContinue: false,
    } as never) as InstanceType<typeof Agent>;
    await a.init();
    a.enqueuePrompt("do the thing", "user");
    a.start("t");
    try {
      const deadline = Date.now() + 15_000;
      let events: Awaited<ReturnType<typeof readEvents>> = [];
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        events = await readEvents(`${sd}/chat.jsonl`);
        if (events.some((e) => e.type === "system_note" && dataOf(e).event === "auto-continue-after-progress")) break;
      }
      assert.ok(
        events.some((e) => e.type === "system_note" && dataOf(e).event === "auto-continue-after-progress"),
        "filing a report and stopping must continue the loop, with auto-continue off and no goal",
      );
      const nudge = events
        .filter((e) => e.type === "prompt" && dataOf(e).source === "harness")
        .map((e) => String(dataOf(e).text ?? ""))
        .join("\n");
      assert.match(nudge, /A report is not a stopping point/, "and says why it was nudged");
      assert.doesNotMatch(nudge, /goal above/, "the wording must not assume a goal exists");
      assert.ok(calls >= 3, `the loop must have continued (model calls: ${calls})`);
    } finally {
      await a.dispose();
    }
  });
});

test("two report-only rounds in a row both get answered (#215)", async () => {
  /**
   * MEASURED on the operator's own session: `report_progress` → "reported." → `round complete`, no nudge. The budget
   * (`reportedNudges`) was only reset by a round that called a WORK tool, so a report-only round spent it and the next
   * report-only round was skipped. The budget is per ROUND now.
   */
  await useTempDirs(["ac215e-", "ac215f-"], async ([ws, sd]) => {
    let calls = 0;
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (): Promise<LlmResult> => {
        calls += 1;
        // every odd call files a report, every even one answers "reported." and stops
        if (calls % 2 === 1)
          return reply("", [tc(`p${calls}`, "report_progress", { doing: "x", goalStatus: "y", recent: "z" })]);
        return reply("reported.");
      },
      autoContinue: false,
    } as never) as InstanceType<typeof Agent>;
    await a.init();
    a.enqueuePrompt("do the thing", "user");
    a.start("t");
    try {
      const deadline = Date.now() + 15_000;
      let notes = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        const events = await readEvents(`${sd}/chat.jsonl`);
        notes = events.filter((e) => e.type === "system_note" && dataOf(e).event === "auto-continue-after-progress").length;
        if (notes >= 2) break;
      }
      assert.ok(notes >= 2, `both report rounds must be answered (nudges: ${notes}, calls: ${calls})`);
    } finally {
      await a.dispose();
    }
  });
});
