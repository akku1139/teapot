import { test } from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent/agent.ts";
import { isSummarizerRequest } from "./helpers/summarizer-request.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

test("a summarizer request that is TOO LARGE shrinks and retries (#127, #150)", async () => {
  const ws = mkdtempInRootSync("t127x-");
  const sd = mkdtempInRootSync("t127y-");
  const LIMIT = 60_000;
  const sizes: number[] = [];
  let n = 0;
  const a = new Agent({
    id: "c",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (_l: unknown, m: unknown) => {
      if (isSummarizerRequest(m)) {
        const len = JSON.stringify(m).length;
        sizes.push(len);
        if (len > LIMIT) {
          const err = new Error(
            "This model's maximum context length is exceeded. Please reduce the length of the messages.",
          ) as Error & { status: number };
          err.status = 400;
          throw err;
        }
        return { message: { role: "assistant" as const, content: "S" } };
      }
      n++;
      if (n % 2 === 0) return { message: { role: "assistant" as const, content: "done" } };
      return {
        message: {
          role: "assistant" as const,
          content: "w",
          tool_calls: [
            {
              id: `t${n}`,
              type: "function" as const,
              function: { name: "write_file", arguments: JSON.stringify({ path: `f${n}.txt`, content: "e".repeat(200) }) },
            },
          ],
        },
      };
    },
    autoContinue: false,
    autoCompact: false, 
    contextTokenBudget: 4000,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  for (let i = 0; i < 4; i++) {
    a.enqueuePrompt("Q".repeat(30_000), "user");
    a.start("t");
    await a.settled();
  }
  try {
    await a.compactNow();
    assert.ok(sizes.length >= 2, `the summarizer must have been retried (#127): ${JSON.stringify(sizes)}`);
    assert.ok(
      sizes[0]! > LIMIT,
      `precondition: the first attempt must be over the limit (#127): ${sizes[0]}`,
    );
    assert.ok(
      sizes[sizes.length - 1]! <= LIMIT,
      `the retry must fit under the limit (#127): ${JSON.stringify(sizes)}`,
    );
    assert.ok(
      sizes.length <= 1 + 3,
      `and the retries must be BOUNDED (#127, ZCode uses 3): ${sizes.length} attempts`,
    );
    assert.ok(
      a.stats.compactions >= 1,
      "the compaction must still SUCCEED after shrinking, not fall back to truncation",
    );
  } finally {
    a.stop("done");
    await a.settled().catch(() => {});
  }
});
