/**
 * The summarizer request must SHRINK when it is itself too large.
 *
 * Replaying the conversation prefix (rather than a flattened transcript) is what makes
 * the auxiliary call reuse the provider's KV cache — but it also means there is no
 * 120k-character truncation keeping the input bounded any more. The replayed region is
 * normally the head of a request that already succeeded, so it fits; it does not ALWAYS,
 * because the cut can land such that the shadowed region is nearly the whole history,
 * and because after a real overflow the conversation was over its window to begin with.
 *
 * So the request shrinks and retries, shedding LEADING messages — which keeps it a
 * cacheable prefix of the routed request — a bounded number of times, exactly as ZCode
 * does with its `prompt-too-long` retry count. This file is separate from
 * compaction-liveness.test.ts because it drives a deliberately over-budget history with
 * auto-compaction off, which is a different fixture from the liveness assertions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent/agent.ts";
import { isSummarizerRequest } from "./helpers/summarizer-request.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

test("a summarizer request that is TOO LARGE shrinks and retries (#127, #150)", async () => {
  // The replayed prefix is normally the head of a request that already succeeded, so
  // it fits. It does NOT always: the cut can land such that the shadowed region is
  // nearly the whole history, and after a real overflow the conversation was over its
  // window to begin with. There is no truncation to save it any more, so the request
  // must SHRINK.
  //
  // The shrink sends FEWER LEADING messages, so it stays a cacheable prefix of the
  // routed request. The mock rejects anything over `LIMIT` — how a real provider
  // behaves — and `autoCompact: false` lets the history grow past it first, since
  // leaving auto-compaction on keeps trimming the history below the limit and the
  // condition would never arise.
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
      // alternate: a tool call, then a plain reply, so each round ends after two
      // turns. A mock that ALWAYS issues a tool call runs to maxTurnsPerRound (200)
      // every round, and with `autoCompact: false` the history never shrinks — the
      // test then takes minutes instead of seconds.
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
    autoCompact: false, // let the history grow past LIMIT first
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
