/**
 * "queued…" must come from the SERVER's answer, not from what the client happens to hold.
 *
 * MEASURED (v0.37.165, still reported): a prompt sent to an IDLE agent blinked "queued…". The label was decided from
 * `pendingPrompts` in the last snapshot (which lags) and from leftover local echoes, so a stale or unrelated count made
 * a prompt that starts the agent look like it was waiting behind something.
 *
 * Contract:
 *   - `pendingAheadOf(id)` = prompts enqueued BEFORE it, plus one if a turn is running and nothing is queued ahead of it;
 *   - a prompt that starts an idle agent is therefore 0, and that is what the row's label is drawn from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

async function agent(sd: string, ws: string) {
  const a = new Agent({
    id: "ahead",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  return a;
}

test("a prompt that starts an idle agent has nothing ahead of it", async () => {
  await useTempDirs(["ahead-a-", "ahead-sd-"], async ([ws, sd]) => {
    const a = await agent(sd, ws);
    try {
      const id = a.enqueuePrompt("go", "user");
      assert.equal(a.pendingAheadOf(id), 0, "an idle agent starts on it — it queues behind nothing");
    } finally {
      a.stop("test done");
    }
  });
});

test("a prompt behind a running turn waits for it", async () => {
  await useTempDirs(["ahead-b-", "ahead-sd-"], async ([ws, sd]) => {
    const a = await agent(sd, ws);
    try {
      (a as unknown as { status: string }).status = "running";
      const id = a.enqueuePrompt("go", "user");
      assert.equal(a.pendingAheadOf(id), 1, "the turn in flight is what it waits for");
    } finally {
      a.stop("test done");
    }
  });
});

test("the second prompt of a queue waits behind the first, not behind a turn it already counted", async () => {
  await useTempDirs(["ahead-c-", "ahead-sd-"], async ([ws, sd]) => {
    const a = await agent(sd, ws);
    try {
      (a as unknown as { status: string }).status = "running";
      const first = a.enqueuePrompt("one", "user");
      const second = a.enqueuePrompt("two", "user");
      assert.equal(a.pendingAheadOf(first), 1, "first waits for the turn");
      assert.equal(a.pendingAheadOf(second), 1, "second waits for the first prompt, and that is all it says");
    } finally {
      a.stop("test done");
    }
  });
});

test("an unknown id has nothing ahead of it", async () => {
  await useTempDirs(["ahead-d-", "ahead-sd-"], async ([ws, sd]) => {
    const a = await agent(sd, ws);
    try {
      assert.equal(a.pendingAheadOf("not-a-prompt"), 0);
    } finally {
      a.stop("test done");
    }
  });
});

test("the enqueued prompt event records the queue position it had (no inference for the row)", async () => {
  await useTempDirs(["ahead-e-", "ahead-sd-"], async ([ws, sd]) => {
    const a = await agent(sd, ws);
    try {
      (a as unknown as { status: string }).status = "running";
      /**
       * The append happens after the agent is ready, so spy on it rather than racing the file: what matters is the DATA
       * the row will be drawn from (`ahead`), not when the write lands.
       */
      const seen: { type: string; data: Record<string, unknown> }[] = [];
      const log = a.log as unknown as { append: (type: string, s: string, b: string, data: Record<string, unknown>) => Promise<unknown> };
      const real = log.append.bind(a.log);
      log.append = async (type, sess, branch, data) => {
        seen.push({ type, data });
        return real(type, sess, branch, data);
      };
      a.enqueuePrompt("one", "user");
      for (let i = 0; i < 100 && !seen.some((s2) => s2.type === "prompt"); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const row = seen.find((s2) => s2.type === "prompt");
      assert.ok(row, "the prompt must be logged");
      assert.equal(
        row!.data.ahead,
        1,
        "the row carries the position, so the client does not have to guess from delivery timing",
      );
    } finally {
      a.stop("test done");
    }
  });
});
