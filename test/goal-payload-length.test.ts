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
  const long = "これは長いゴールです。".repeat(60); 
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
    assert.ok(served.endsWith("これは長いゴールです。"), "the tail of the goal must survive");
  });
});
