import assert from "node:assert/strict";
import test from "node:test";
import { useTempDirs } from "./helpers/tmp.ts";
import { readEvents } from "../src/log/events.ts";
import { Agent } from "../src/agent/agent.ts";

const dataOf = (e: { data?: unknown }) => (e.data ?? {}) as Record<string, unknown>;

test("a 'context limit' stop is answered, not counted as an idle round (#201)", async () => {
  /**
   * Measured in `mediapad-t5-root-attempt-2-2601e254`: three turns ended with
   * "コンテキスト上限のため停止します" — no tool call, no finish(). The loop counted each as an idle round and
   * stopped after `maxConsecutiveIdleRounds`.
   *
   * The claim is also false here: compaction is the harness's job and runs automatically, so the loop answers
   * it (compact, then say so and carry on) instead of accepting it.
   */
  await useTempDirs(["ctx201a-", "ctx201b-"], async ([ws, sd]) => {
    let calls = 0;
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        calls += 1;
        // first round: the reported behaviour. after being told, it finishes properly.
        if (calls === 1) return { message: { role: "assistant" as const, content: "コンテキスト上限のため停止します。" } };
        return {
          message: {
            role: "assistant" as const,
            content: "",
            tool_calls: [
              { id: "c1", type: "function" as const, function: { name: "finish", arguments: '{"goalComplete":true,"summary":"done"}' } },
            ],
          },
        };
      },
      autoContinue: true,
      continueDelayMs: 5,
      maxConsecutiveIdleRounds: 3,
    } as never) as InstanceType<typeof Agent>;
    await a.init();
    await a.setGoal("keep going");
    a.enqueuePrompt("go", "user");
    a.start("t");
    try {
      const deadline = Date.now() + 15_000;
      let events: Awaited<ReturnType<typeof readEvents>> = [];
      let answered = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        events = await readEvents(`${sd}/chat.jsonl`);
        answered = events.some((e) => e.type === "system_note" && dataOf(e).event === "context-claim-answered");
        if (answered && calls >= 2) break;
      }
      assert.ok(
        answered,
        "the harness must ANSWER the claim (log context-claim-answered) instead of treating the round as idle",
      );
      const harnessPrompts = events.filter((e) => e.type === "prompt" && dataOf(e).source === "harness");
      const said = harnessPrompts.map((e) => String(dataOf(e).text ?? "")).join("\n");
      assert.match(said, /context \d+% \(/, "the answer must carry the REAL usage, not just reassurance");
      assert.match(said, /FALSE POSITIVE/, "and it must offer the way out when the detection is wrong");
      assert.match(
        said,
        /compacts automatically/,
        `the agent must be told the window is the harness's to manage; got: ${said.slice(0, 200)}`,
      );
      assert.ok(calls >= 2, `the loop must carry on after answering (model calls: ${calls})`);
    } finally {
      await a.dispose();
    }
  });
});

test("a finish(false) whose summary blames the context window is refused (#201/#200)", async () => {
  /**
   * This is how it actually arrived: in `mediapad-t5-root-attempt-2-2601e254` the stopping turns were
   * `finish(goalComplete=false)` calls reading "コンテキスト上限のため停止します", not prose. A fix that only
   * covered the no-tool-call path would have missed every occurrence.
   */
  await useTempDirs(["ctx201c-", "ctx201d-"], async ([ws, sd]) => {
    let calls = 0;
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        calls += 1;
        const args =
          calls === 1
            ? { goalComplete: false, summary: "temproot 未達。コンテキスト上限のため停止します。" }
            : { goalComplete: true, summary: "done" };
        return {
          message: {
            role: "assistant" as const,
            content: "",
            tool_calls: [
              { id: `c${calls}`, type: "function" as const, function: { name: "finish", arguments: JSON.stringify(args) } },
            ],
          },
        };
      },
      autoContinue: true,
      continueDelayMs: 5,
    } as never) as InstanceType<typeof Agent>;
    await a.init();
    await a.setGoal("keep going");
    a.enqueuePrompt("go", "user");
    a.start("t");
    try {
      const deadline = Date.now() + 15_000;
      let events: Awaited<ReturnType<typeof readEvents>> = [];
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        events = await readEvents(`${sd}/chat.jsonl`);
        const refused = events.some(
          (e) => e.type === "system_note" && dataOf(e).event === "context-claim-answered" && dataOf(e).via === "finish",
        );
        if (refused && calls >= 2) break;
      }
      assert.ok(
        events.some(
          (e) => e.type === "system_note" && dataOf(e).event === "context-claim-answered" && dataOf(e).via === "finish",
        ),
        "a context-blaming finish(false) must be refused and answered",
      );
      assert.ok(calls >= 2, `the agent must get another turn instead of ending on that finish (calls: ${calls})`);
    } finally {
      await a.dispose();
    }
  });
});
