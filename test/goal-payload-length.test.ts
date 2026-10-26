/**
 * A LONG GOAL REACHES THE UI WHOLE.
 *
 * Reported: "goalに設定されている文字列が長いとフロントエンドのgoal欄で後半が切られる? 全部表示されて
 * ほしい". The right panel's goal card is the only place the operator sees the text they wrote, so a
 * cap there is silent data loss rather than a display choice.
 *
 * MEASURED: with a 1500-character `goal.md`, `/api/agents` returned exactly 400 characters and the
 * card rendered to the end of that prefix — no visual cue that anything was missing, which is why it
 * read as "the goal got truncated when I saved it".
 *
 * `snapshot()` is the payload `/api/agents` serves, so asserting on it is asserting on what the
 * browser receives. The test would pass with any cap above the fixture length, which is why the
 * fixture is longer than the 400 that was there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmConfig } from "../src/agent/llm.ts";

const LLM: LlmConfig = { baseUrl: "http://mock", apiKey: "mock", model: "mock-model" };

async function withAgent<T>(fn: (a: Agent) => Promise<T> | T): Promise<T> {
  return useTempDirs(["teapot-goal-payload-ws-", "teapot-goal-payload-sess-"], async ([ws, sessionDir]) => {
    const agent = new Agent({ id: "t", workspace: ws, llm: LLM, sessionDir, continueDelayMs: 10 });
    await agent.init();
    return fn(agent);
  });
}

test("a long goal is served to the UI in full, not clipped (#goal-length)", async () => {
  // longer than the 400-character cap that was here, and long enough that a truncation is obvious
  const long = "これは長いゴールです。".repeat(60); // 660 chars
  assert.ok(long.length > 400, "the fixture must exceed the cap under test or this proves nothing");

  await withAgent(async (agent) => {
    await agent.setGoal(long);
    const served = agent.snapshot().goal.text;
    assert.equal(
      served.length,
      long.length,
      `the UI receives ${served.length} of ${long.length} characters — a truncated goal reads as ` +
        `a goal that was saved wrong (#goal-length)`,
    );
    assert.equal(served, long, "the goal must arrive byte-identical, not merely the same length");
    // and the END is what a truncation loses, so assert on the tail explicitly
    assert.ok(served.endsWith("これは長いゴールです。"), "the tail of the goal must survive");
  });
});
