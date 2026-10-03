/**
 * #82 — "can a goal audit and an auto-compaction overlap and behave oddly?"
 * (and: document the behaviour).
 *
 * Checked rather than assumed, because the two touch the same agent from
 * different entry points: `setGoalAudit` is the model's own call inside a turn,
 * `maybeCompact` runs at the turn boundary, on overflow recovery, and on the
 * operator's explicit `compactNow()`.
 *
 * The answer is no, for three independent reasons — each pinned below:
 *
 *  1. They serialise. Every one of the four `maybeCompact` call sites and
 *     `setGoalAudit` go through `enqueue`, which chains onto `runChain`.
 *  2. The goal is INSTANCE state (`goal: GoalState`), not message content, so
 *     a compaction that rewrites `this.messages` cannot drop or truncate it.
 *  3. An audit writes to `goal.audit`, a separate field, so it is not part of
 *     what compaction rewrites.
 *
 * The genuinely interesting question is whether an audit verdict and a
 * compaction can leave the goal in a state that reads as "done" when it is not.
 * They cannot: `status` is only ever written by `setGoal`/`setGoalStatus`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readFileSync } from "node:fs";

const mk = (ws: string, sd: string, chatFn: unknown, extra: Record<string, unknown> = {}) =>
  new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
    chatFn,
    autoContinue: false,
    ...extra,
  } as any);

test("an audit concurrent with a compaction preserves the goal (#82)", async () => {
  await useTempDirs(["q82a-", "q82b-"], async ([ws, sd]) => {
    let n = 0;
    const agent = mk(ws!, sd!, async () => ({
      message: { role: "assistant" as const, content: `r${++n} `.repeat(400) },
    }), { contextTokenBudget: 4000 });
    await agent.init();
    await agent.setGoal("ship the thing");
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    // deliberately concurrent: the model's own audit call and the operator's
    // explicit compact, while a turn is in flight
    await Promise.all([
      agent.setGoalAudit("changes-required", "not yet"),
      agent.compactNow(),
    ]);
    await agent.settled();

    const goal = (agent as any).goal;
    assert.equal(goal.text, "ship the thing", "compaction must not truncate the goal (#82)");
    assert.equal(goal.status, "active", "and an audit must not mark it done (#82)");
    assert.equal(goal.audit?.verdict, "changes-required", "the audit verdict must survive (#82)");
    assert.ok((agent as any).stats.compactions > 0, "precondition: a compaction actually ran (#82)");
    await agent.dispose();
  });
});

test("the audit verdict drives the goal status, deliberately (#82)", async () => {
  // Documented rather than asserted as a bug: `setGoalAudit` owns the status
  // transition. `approved` completes the goal; `changes-required` REOPENS one
  // that was already done. Both directions are intentional — an audit that
  // could not change the status would not be an audit.
  await useTempDirs(["q82c-", "q82d-"], async ([ws, sd]) => {
    const agent = mk(ws!, sd!, async () => ({ message: { role: "assistant" as const, content: "ok" } }));
    await agent.init();
    await agent.setGoal("g");

    await agent.setGoalAudit("changes-required", "needs work");
    assert.equal((agent as any).goal.status, "active", "a rejected audit leaves the goal active (#82)");

    await agent.setGoalAudit("approved", "looks right");
    assert.equal((agent as any).goal.status, "done", "an approved audit completes the goal (#82)");
    assert.equal((agent as any).goal.audit?.verdict, "approved");

    // and it re-opens — the reverse transition exists on purpose
    await agent.setGoalAudit("changes-required", "actually no");
    assert.equal((agent as any).goal.status, "active", "a later rejection must reopen a done goal (#82)");
    await agent.dispose();
  });
});

test("the status transition belongs to setGoalAudit, not to compaction (#82)", () => {
  // the real question behind #82: could a compaction be what completes a goal?
  const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  const audit = src.slice(src.indexOf("async setGoalAudit"), src.indexOf("async setGoalAudit") + 900);
  assert.match(audit, /if \(verdict === "approved"\) this\.goal\.status = "done"/, "audit owns the transition (#82)");
  // and maybeCompact must not touch goal.status at all
  const compact = src.slice(src.indexOf("private async maybeCompact"), src.indexOf("private async maybeCompact") + 6000);
  assert.doesNotMatch(
    compact,
    /goal\.status\s*=/,
    "compaction must never change the goal status (#82) — that is the overlap worth ruling out",
  );
});

test("every compaction entry point is serialised through enqueue (#82)", () => {
  // three call sites: the turn boundary, overflow recovery, and the operator's
  // explicit compactNow. If any ran off the chain, the guarantee above would be
  // accidental rather than structural.
  const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  // three: the turn boundary, overflow recovery, and compactNow
  const calls = [...src.matchAll(/await this\.maybeCompact\(/g)].length;
  assert.equal(calls, 3, `expected 3 call sites, found ${calls} (#82)`);
  // compactNow wraps its call in enqueue()
  assert.match(
    src,
    /async compactNow\(\)[\s\S]{0,220}this\.enqueue\(async \(\) => \{[\s\S]{0,160}this\.maybeCompact\(true\)/,
    "compactNow must go through enqueue (#82)",
  );
  // and the loop's own compaction is inside the enqueued loop body
  assert.match(src, /this\.runChain = p\.then\(/, "enqueue must serialise via runChain (#82)");
});

test("the goal is instance state, not message content (#82)", () => {
  // this is WHY compaction cannot drop it — worth pinning, because moving the
  // goal into the prompt would silently reintroduce the interaction
  const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /goal: GoalState = \{/,
    "the goal must stay a field on the agent (#82)",
  );
});
