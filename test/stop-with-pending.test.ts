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
 * So the real risk is not "survives" — it is "survives and is MISREPRESENTED".
 * That is what these tests pin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

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

/* ---------- claim 2: the UI must not imply progress ---------- */

test("the badge says STOPPED when the agent is stopped (#9)", () => {
  assert.match(
    app,
    /queued\{sel\(\)!\.status === "stopped" \? " \(stopped\)" : ""\}/,
    'the badge must read "N of yours queued (stopped)" (#9)',
  );
});

test("the tooltip says nothing will run until start (#9)", () => {
  // the badge alone is easy to miss; the tooltip is where the truth lives
  assert.match(
    app,
    /this agent is STOPPED — nothing will run until you press start/,
    "the tooltip must say the agent is stopped and idle until resumed (#9)",
  );
  assert.match(
    app,
    /Each can be withdrawn with ✕ cancel while it is still queued/,
    "and that cancelling still works while stopped (#9)",
  );
});

test("the two tooltip branches are genuinely different (#9)", () => {
  // a single string used for both states would satisfy either match alone
  const at = app.indexOf('title={\n                  sel()!.status === "stopped"');
  assert.notEqual(at, -1, "the tooltip must branch on status (#9)");
  const block = app.slice(at, app.indexOf("}", app.indexOf("</span>", at)));
  assert.match(block, /stopped[\s\S]*nothing will run[\s\S]*handed to the model at its next turn boundary/,
    "stopped and running must say different things (#9)");
});