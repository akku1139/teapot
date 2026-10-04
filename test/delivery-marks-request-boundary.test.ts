/**
 * #37 — the timeline must show events in the order requests were actually SENT
 * to the LLM API.
 *
 * ## What was wrong
 *
 * `prompt-delivered` was logged in `drainPendingPrompts`, which runs at a turn
 * boundary BEFORE `refreshSkills`, `maybeRequestProgress` and `maybeCompact`. So
 * the marker did not mean "the request carrying this prompt has started" — it
 * meant "the prompt moved from the queue into `this.messages`", which is earlier.
 *
 * Measured before the fix:
 *
 *     LLM CALL #1
 *       seq=5  prompt-delivered("first prompt")
 *       seq=6  llm turn start
 *
 * The UI reorders by this marker (`resequenceToDelivery`), so the SEMANTICS were
 * the bug — not `timeline-order.ts`, which was working correctly on a marker that
 * was recorded too early.
 *
 * Worse, `maybeCompact()` can itself make an LLM call, so the marker could claim
 * a delivery order the API never saw.
 *
 * ## The fix
 *
 * Drained prompts are queued, and the marker is emitted from inside `llmCall`
 * immediately before the outbound request. The UI needs no change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { readFileSync } from "node:fs";

interface Ev {
  seq: number;
  type: string;
  data?: Record<string, unknown>;
}

/** drive the agent and return its events plus the observed LLM calls */
async function drive(
  ws: string,
  sd: string,
  opts: { budget?: number; prefill?: boolean } = {},
): Promise<{ events: Ev[]; calls: number }> {
  let calls = 0;
  const a = new Agent({
    id: "p",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    contextTokenBudget: opts.budget,
    chatFn: async () => {
      calls++;
      // the second call in the compaction fixture is the summariser
      return calls > 1 && opts.budget
        ? { message: { role: "assistant" as const, content: "SUMMARY" } }
        : { message: { role: "assistant" as const, content: "ok" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  if (opts.prefill) {
    a.messages.push({ role: "user", content: "x".repeat(4000) });
    a.messages.push({ role: "assistant", content: "y".repeat(4000) });
  }
  a.enqueuePrompt("do the thing", "user");
  a.start("t");
  await new Promise((r) => setTimeout(r, 900));
  return { events: (await readEvents(`${sd}/chat.jsonl`)) as Ev[], calls };
}

const deliveredSeq = (evs: Ev[]) =>
  evs.find((e) => e.type === "system_note" && e.data?.event === "prompt-delivered")?.seq ?? -1;
const turnStartSeq = (evs: Ev[]) =>
  evs.find((e) => e.type === "state" && String(e.data?.detail ?? "").includes("llm turn start"))?.seq ?? -1;
const compactionSeq = (evs: Ev[]) => evs.find((e) => e.type === "compaction")?.seq ?? -1;

test("prompt-delivered is recorded when the request starts, not when queued (#37)", async () => {
  await useTempDirs(["t37a-", "t37b-"], async ([ws, sd]) => {
    const { events } = await drive(ws!, sd!);
    const d = deliveredSeq(events);
    const t = turnStartSeq(events);
    assert.notEqual(d, -1, "precondition: the marker is logged (#37)");
    assert.notEqual(t, -1, "precondition: the turn start is logged (#37)");
    assert.ok(
      d > t,
      `the marker must follow the request it describes (#37): delivered seq=${d}, turn start seq=${t}`,
    );
  });
});

test("a compaction request precedes the marker (#37)", async () => {
  // maybeCompact() makes its OWN LLM call. The marker must not claim delivery
  // before the summariser has run, or the timeline shows an order the API
  // never saw.
  await useTempDirs(["t37c-", "t37d-"], async ([ws, sd]) => {
    const { events, calls } = await drive(ws!, sd!, { budget: 400, prefill: true });
    assert.ok(calls > 1, `precondition: compaction must run (#37); calls=${calls}`);
    const c = compactionSeq(events);
    assert.notEqual(c, -1, "precondition: the compaction is logged (#37)");
    const d = deliveredSeq(events);
    assert.ok(d > c, `the marker must follow the compaction request (#37): compaction seq=${c}, delivered seq=${d}`);
  });
});

test("a retry does not move the marker (#37)", async () => {
  // the marker is emitted once per REQUEST, not per attempt: a retry resends the
  // same payload, so re-emitting would push the marker past later events on
  // every try
  await useTempDirs(["t37e-", "t37f-"], async ([ws, sd]) => {
    let calls = 0;
    const a = new Agent({
      id: "p",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        calls++;
        // fail the first attempt so the retry path runs
        if (calls === 1) throw Object.assign(new Error("boom"), { name: "ProviderError" });
        return { message: { role: "assistant" as const, content: "ok" } };
      },
      autoContinue: false,
      // the built-in backoff is 5s/5s/30s and is NOT configurable, so the test
      // must outlast it — a shorter wait asserted nothing about the retry path
    } as never) as Agent;
    await a.init();
    await a.setGoal("g");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 7_000));
    const events = (await readEvents(`${sd}/chat.jsonl`)) as Ev[];
    const markers = events.filter(
      (e) => e.type === "system_note" && e.data?.event === "prompt-delivered",
    );
    assert.ok(calls >= 2, `precondition: a retry must happen (#37); calls=${calls}`);
    assert.equal(
      markers.length,
      1,
      `one request, one marker (#37); got ${markers.length}`,
    );
  });
});

test("the marker is not written at drain time (#37)", () => {
  // structural: the whole bug was the call site, so pin it
  const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  const drain = src.slice(
    src.indexOf("private drainPendingPrompts"),
    src.indexOf("private drainPendingPrompts") + 1600,
  );
  assert.doesNotMatch(
    drain,
    /event: "prompt-delivered"/,
    "the marker must NOT be logged in drainPendingPrompts (#37) — it runs before the request",
  );
  const mark = src.indexOf("private async markDeliveredPrompts");
  assert.notEqual(mark, -1, "the boundary marker must exist (#37)");
  // anchor on the CALL, not on a fixed-width slice: `markDeliveredPrompts` sits
  // further into llmCall than 1600 chars, so a window silently found nothing
  const callAt = src.indexOf("await this.markDeliveredPrompts()");
  assert.notEqual(callAt, -1, "the boundary marker must be CALLED (#37)");
  const call = src.slice(src.lastIndexOf("private async llmCall", callAt), callAt);
  assert.match(
    call,
    /if \(attempt === 1\)/,
    "and only on the FIRST attempt — a retry resends the same payload (#37)",
  );
});