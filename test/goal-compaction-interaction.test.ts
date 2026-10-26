import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

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
  await useTempDirs(["q82c-", "q82d-"], async ([ws, sd]) => {
    const agent = mk(ws!, sd!, async () => ({ message: { role: "assistant" as const, content: "ok" } }));
    await agent.init();
    await agent.setGoal("g");

    await agent.setGoalAudit("changes-required", "needs work");
    assert.equal((agent as any).goal.status, "active", "a rejected audit leaves the goal active (#82)");

    await agent.setGoalAudit("approved", "looks right");
    assert.equal((agent as any).goal.status, "done", "an approved audit completes the goal (#82)");
    assert.equal((agent as any).goal.audit?.verdict, "approved");

    await agent.setGoalAudit("changes-required", "actually no");
    assert.equal((agent as any).goal.status, "active", "a later rejection must reopen a done goal (#82)");
    await agent.dispose();
  });
});

