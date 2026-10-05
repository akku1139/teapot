/**
 * #136 — the auto-continue nudge said "the current goal" and never said what it
 * was, and carried no `[harness]` prefix.
 *
 * ## Why this made the agent run forever
 *
 * The nudge is re-injected at every auto-continue boundary. Without the prefix it
 * was indistinguishable from something the operator typed, so the model read
 * "Continue working toward the current goal…" as a request to REPLY — then
 * answered in prose, which ends the round without `finish()`ing, which starts the
 * next round, which repeats. Only the `maxConsecutiveIdleRounds` safety valve
 * eventually stopped it.
 *
 * And even read correctly, "the current goal" is unactionable if the goal is not
 * restated: a long-running root agent that has lost the thread has nothing to
 * re-anchor on.
 *
 * The SUB-agent variant has always included its task text, precisely for that
 * reason — a forked child otherwise drifts back into the inherited conversation
 * and keeps going forever (#106). The root nudge never got it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent, AUTO_CONTINUE_NUDGE, autoContinueNudge } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

/* ---------- the string ---------- */

test("the nudge is prefixed [harness] (#136)", () => {
  assert.ok(
    AUTO_CONTINUE_NUDGE.startsWith("[harness] "),
    `every injected instruction carries the prefix, or the model reads it as operator text (#136): ${AUTO_CONTINUE_NUDGE.slice(0, 40)}`,
  );
});

test("the original instruction survives verbatim (#43)", () => {
  // the prefix must be ADDED, not substituted — #43's wording is load-bearing and
  // existing harness prompts/tests key off it
  // with the prefix the string no longer STARTS with it — the prefix is added,
  // not substituted, so the sentence follows immediately
  assert.match(
    AUTO_CONTINUE_NUDGE,
    /^\[harness\] Continue working toward the current goal\./,
    "the prefix is prepended, the sentence is unchanged (#43/#136)",
  );
  assert.match(AUTO_CONTINUE_NUDGE, /goalComplete=true/);
  assert.match(AUTO_CONTINUE_NUDGE, /goalComplete=false/);
});

/* ---------- the builder ---------- */

test("the builder restates the goal (#136)", () => {
  const goal = "fix the code based on the current review and release the next version";
  const nudge = autoContinueNudge(goal);
  assert.ok(nudge.startsWith("[harness] "), "still prefixed (#136)");
  assert.ok(nudge.includes(goal), "and names the goal (#136)");
  assert.match(nudge, /Current goal:\n=====/, "with the delimiter the issue asked for (#136)");
  assert.ok(
    nudge.includes(AUTO_CONTINUE_NUDGE),
    "and composes the shared constant rather than restating it (#136)",
  );
});

test("an empty goal falls back to the bare nudge (#136)", () => {
  // a whitespace-only goal must not produce an empty "Current goal:" block
  assert.equal(autoContinueNudge(""), AUTO_CONTINUE_NUDGE);
  assert.equal(autoContinueNudge("   \n "), AUTO_CONTINUE_NUDGE);
});

test("a huge goal is clipped, as the sub-agent nudge's is (#136)", () => {
  // otherwise a 20k-character goal re-enters the context on EVERY round
  const nudge = autoContinueNudge("g".repeat(5000));
  assert.ok(nudge.length < 2000, `must be clipped (#136); got ${nudge.length} chars`);
});

/* ---------- what the model actually receives ---------- */

test("the nudge a never-finishing agent receives names the goal (#136)", async () => {
  // end to end: drive the real loop with a model that never calls finish(), and
  // read what was actually injected
  await useTempDirs(["t136a-", "t136b-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({ message: { role: "assistant" as const, content: "still working" } }),
      autoContinue: true,
      continueDelayMs: 5,
      maxConsecutiveIdleRounds: 3,
    } as never) as Agent;
    await a.init();
    await a.setGoal("fix the code based on the current review and release the next version");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const events = await readEvents(`${sd}/chat.jsonl`);
      const nudges = events.filter((e) => e.type === "prompt" && e.data?.source === "harness");
      assert.ok(nudges.length > 0, "precondition: the agent was auto-continued (#136)");
      const last = String(nudges[nudges.length - 1]!.data?.text ?? "");
      assert.ok(last.startsWith("[harness] "), `the injected nudge must be prefixed (#136); got ${last.slice(0, 40)}`);
      assert.ok(
        last.includes("fix the code based on the current review"),
        "and must name the goal it refers to (#136)",
      );
      assert.match(last, /=====/, "with the delimiter (#136)");
    } finally {
      a.stop("done");
      await a.settled().catch(() => {});
    }
  });
});

test("the sub-agent nudge is unaffected (#136)", () => {
  // it already restated its task; it must not acquire a second copy
  const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  const m = /\[harness\] Auto-nudge\.[^`]*/.exec(src)?.[0] ?? "";
  assert.ok(m.length > 0, "the sub-agent nudge must exist (#136)");
  assert.equal((m.match(/Current goal:/g) ?? []).length, 0, "it uses its own wording (#136)");
  assert.ok(m.includes("YOUR task"), "and still names its own task (#136)");
});

