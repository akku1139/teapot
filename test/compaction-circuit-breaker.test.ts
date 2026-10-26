import { test } from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { isSummarizerRequest } from "./helpers/summarizer-request.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

async function failingSummarizer(rounds: number) {
  const ws = mkdtempInRootSync("cb-");
  const sd = mkdtempInRootSync("cbs-");
  let summarizerCalls = 0;
  let n = 0;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (_c: unknown, m: unknown) => {
      if (isSummarizerRequest(m)) {
        summarizerCalls++;
        throw new Error("summarizer unavailable");
      }
      n++;
      return {
        message: {
          role: "assistant" as const,
          content: "w",
          tool_calls: [
            {
              id: `t${n}`,
              type: "function" as const,
              function: { name: "write_file", arguments: JSON.stringify({ path: `g${n}.txt`, content: "e".repeat(300) }) },
            },
          ],
        },
      };
    },
    contextTokenBudget: 3000,
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  for (let i = 0; i < rounds; i++) {
    a.enqueuePrompt(`go ${i} ${"y".repeat(8000)}`);
    a.start("t");
    await a.settled();
  }
  return { a, calls: () => summarizerCalls };
}

test("auto-compaction gives up after 3 consecutive failures (#150, ZCode)", async () => {
  const { a, calls } = await failingSummarizer(6);
  try {
    assert.equal(
      calls(),
      3,
      `the provider must not be re-burned on every turn after the pass cannot succeed (#150): ${calls()} attempts`,
    );
    const notes = (await readEvents(a.log.filePath))
      .filter((e) => e.type === "system_note")
      .map((e) => e.data as Record<string, unknown>);
    assert.ok(
      notes.filter((d) => d.event === "context-compacted").length >= 3,
      "the truncate fallback must still reclaim the budget each time — the breaker stops the SUMMARIZE, not the compaction",
    );
  } finally {
    a.stop("done");
    await a.settled().catch(() => {});
  }
});

test("the failure never fails the agent's turn (ZCode: it must not) (#150)", async () => {
  const { a } = await failingSummarizer(4);
  try {
    assert.notEqual(
      a.status,
      "error",
      `a compaction failure is environmental, not the operator's error (#150): ${a.statusReason}`,
    );
  } finally {
    a.stop("done");
    await a.settled().catch(() => {});
  }
});

test("a MANUAL compaction still tries after the breaker has tripped (#150)", async () => {
  const { a, calls } = await failingSummarizer(4);
  try {
    const before = calls();
    await a.compactNow();
    assert.ok(calls() > before, "an explicit /compact must still attempt the summarizer (#150)");
  } finally {
    a.stop("done");
    await a.settled().catch(() => {});
  }
});
