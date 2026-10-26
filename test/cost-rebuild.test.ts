import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

const PRICING = { prompt: 0.001, completion: 0.002 };
const chatFn = async () => ({
  message: { role: "assistant" as const, content: "reply" },
  usage: { inputTokens: 1000, outputTokens: 500 },
});

async function runOneTurn(ws: string, sd: string): Promise<Agent> {
  const a = new Agent({
    id: "c",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn,
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  a.enqueuePrompt("go", "user");
  a.start("t");
  await a.settled();
  await new Promise((r) => setTimeout(r, 150));
  return a;
}

test("restart + pricing-first + first interaction must NOT double the cost", async () => {
  await useTempDirs(["cost1-", "cost2-"], async ([ws, sd]) => {
    const first = await runOneTurn(ws, sd);
    await first.dispose();

    const a = new Agent({
      id: "c",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn,
      autoContinue: false,
    } as never) as Agent;
    try {
      await a.init();
      await a.setModelPricing(PRICING);
      const afterPricing = a.snapshot().stats.costUsd ?? 0;
      assert.equal(afterPricing, 1000 * 0.001 + 500 * 0.002, "the recompute priced the previous session");

      await (a as unknown as { restoreFromLog(): Promise<void> }).restoreFromLog();
      assert.equal(
        a.snapshot().stats.costUsd ?? 0,
        afterPricing,
        "restore must not re-add the cost the recompute already built (2x bug)",
      );
      assert.equal(a.snapshot().stats.inputTokens, 1000, "token totals survive the restore");
    } finally {
      a.stop("end");
      await a.settled().catch(() => {});
      await a.dispose().catch(() => {});
    }
  });
});

test("pricing arriving AFTER the restore still lands the full number (replacement path)", async () => {
  await useTempDirs(["cost3-", "cost4-"], async ([ws, sd]) => {
    const a = await runOneTurn(ws, sd);
    try {
      await (a as unknown as { restoreFromLog(): Promise<void> }).restoreFromLog();
      await a.setModelPricing(PRICING);
      assert.equal(
        a.snapshot().stats.costUsd ?? 0,
        1000 * 0.001 + 500 * 0.002,
        "the late pricing recompute replaces, never adds",
      );
    } finally {
      a.stop("end");
      await a.settled().catch(() => {});
      await a.dispose().catch(() => {});
    }
  });
});
