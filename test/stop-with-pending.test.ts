import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

function agentWithQueue(ws: string, sd: string, opts: Record<string, unknown> = {}) {
  return new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
    autoContinue: false,
    ...opts,
  } as never) as Agent;
}

test("stop does NOT withdraw a queued message (#9)", async () => {
  await useTempDirs(["s9a-", "s9b-"], async ([ws, sd]) => {
    const a = agentWithQueue(ws!, sd!);
    await a.init();
    a.enqueuePrompt("queued work", "user");
    await new Promise((r) => setTimeout(r, 60));
    a.stop("test");
    await new Promise((r) => setTimeout(r, 80));
    const queued = (a as unknown as { pendingPrompts: { text: string }[] }).pendingPrompts;
    assert.equal(
      queued.length,
      1,
      "a stop must NOT destroy queued work — that would be silent data loss (#9)",
    );
    assert.equal(queued[0]!.text, "queued work", "and it must still be the same message (#9)");
    await a.dispose();
  });
});

test("a stopped agent never delivers the queue (#9)", async () => {
  await useTempDirs(["s9c-", "s9d-"], async ([ws, sd]) => {
    let llmCalls = 0;
    const a = agentWithQueue(ws!, sd!, {
      chatFn: async () => {
        llmCalls++;
        return { message: { role: "assistant" as const, content: "ok" } };
      },
    });
    await a.init();
    a.enqueuePrompt("queued work", "user");
    await new Promise((r) => setTimeout(r, 60));
    a.stop("test");
    await new Promise((r) => setTimeout(r, 400));
    const events = await readEvents(`${sd}/chat.jsonl`);
    const delivered = events.filter((e) => e.type === "system_note" && (e.data as { event?: string })?.event === "prompt-delivered");
    await a.dispose();
    assert.equal(llmCalls, 0, "no LLM call may happen while stopped (#9)");
    assert.equal(delivered.length, 0, "nothing may be delivered while stopped (#9)");
  });
});

test("the queue is delivered on a later start (#9)", async () => {
  await useTempDirs(["s9e-", "s9f-"], async ([ws, sd]) => {
    let llmCalls = 0;
    const a = agentWithQueue(ws!, sd!, {
      chatFn: async () => {
        llmCalls++;
        return { message: { role: "assistant" as const, content: "ok" } };
      },
    });
    await a.init();
    a.enqueuePrompt("queued work", "user");
    await new Promise((r) => setTimeout(r, 60));
    a.stop("test");
    await new Promise((r) => setTimeout(r, 120));
    a.start("resumed");
    const deadline = Date.now() + 5_000;
    let events = await readEvents(`${sd}/chat.jsonl`);
    const isDelivered = (evs: typeof events) =>
      evs.some((e) => e.type === "system_note" && (e.data as { event?: string })?.event === "prompt-delivered");
    while (!isDelivered(events) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      events = await readEvents(`${sd}/chat.jsonl`);
    }
    const delivered = events.filter((e) => e.type === "system_note" && (e.data as { event?: string })?.event === "prompt-delivered");
    await a.dispose();
    assert.ok(llmCalls > 0, "a resumed agent must actually run (#9)");
    assert.equal(delivered.length, 1, "and deliver the surviving message (#9)");
  });
});

