/**
 * #9 — "stopping with a pending message behaves oddly."
 *
 * A previous fix (49524d1) addressed one symptom: the reconcile heuristic and a
 * lying badge. This checks the two claims actually made in the latest report
 * against current code.
 *
 *   1. pending messages are NOT withdrawn on stop
 *   2. the UI still shows it as if it were running
 *
 * Claim 1 is intentional, not a bug: a stop must not destroy queued work. The
 * agent is resumable, and a message silently vanishing on stop would be far
 * worse than surviving. What matters is that (a) it is never DELIVERED while
 * stopped, and (b) the UI says so plainly rather than implying progress.
 *
 * (b) used to be pinned by matching tooltip strings in App.tsx — source text,
 * so those are gone; the badge and tooltip are asserted against the real bundle
 * in scripts/smoke-web.ts.
 */
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

/* ---------- claim 1: the queue survives the stop, undelivered ---------- */

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
  // the dangerous direction: surviving is fine, DELIVERING while stopped is not
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
  // survival is only correct if resume actually delivers
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
    await new Promise((r) => setTimeout(r, 400));
    const events = await readEvents(`${sd}/chat.jsonl`);
    const delivered = events.filter((e) => e.type === "system_note" && (e.data as { event?: string })?.event === "prompt-delivered");
    await a.dispose();
    assert.ok(llmCalls > 0, "a resumed agent must actually run (#9)");
    assert.equal(delivered.length, 1, "and deliver the surviving message (#9)");
  });
});

/*
 * The three UI claims that stood here ("the badge says (stopped)", "the tooltip
 * says nothing will run until start", "the two tooltip branches differ") all
 * read App.tsx as TEXT and matched the strings they were checking. A test like
 * that pins the spelling of JSX that has to work at runtime, so they were
 * deleted. The badge/tooltip text is asserted against the REAL BUNDLE in
 * scripts/smoke-web.ts, which can actually exercise the stopped state.
 */
