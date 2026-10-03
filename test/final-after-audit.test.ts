/**
 * #89 — "finish() → notifies parent → audit reject. The parent should not be
 * notified of the finish until the audit is complete."
 *
 * A goal with a `verify` contract goes through an INDEPENDENT completion audit:
 * a tools-less LLM call that checks the contract against the conversation and
 * the worker's summary. `CHANGES-REQUIRED` reopens the goal and queues the
 * auditor's feedback as the next prompt.
 *
 * The bug: the rejection branch queued that retry and then **fell through** to
 * the `log.append("message", { final: true })` below. That `final` flag is
 * precisely what `onChildEvent` forwards to the parent — so a REJECTED
 * completion told the parent the work was DONE, and the child then sat there
 * retrying against a parent that had already moved on and stopped listening.
 *
 * Reproduced before the fix: goal `active`, one retry queued, and **two**
 * `final: true` messages emitted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

/** drive one child through: work → finish(goalComplete) → audit */
async function run(
  ws: string,
  sd: string,
  verdict: string,
): Promise<{ finals: number; status: string; queued: number }> {
  let call = 0;
  const agent = new Agent({
    id: "child",
    parent: "p",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
    chatFn: async () => {
      call++;
      if (call === 1) return { message: { role: "assistant" as const, content: "working" } };
      if (call === 2)
        return {
          message: {
            role: "assistant" as const,
            content: "",
            tool_calls: [
              {
                id: "f1",
                type: "function" as const,
                function: {
                  name: "finish",
                  arguments: JSON.stringify({ goalComplete: true, summary: "all done" }),
                },
              },
            ],
          },
        };
      return { message: { role: "assistant" as const, content: verdict } };
    },
    autoContinue: false,
  } as never) as Agent;
  await agent.init();
  await agent.setGoal("ship it");
  (agent as unknown as { goal: { verify?: string } }).goal.verify =
    "tests pass and typecheck is clean";
  agent.enqueuePrompt("go", "user");
  agent.start("t");
  await agent.settled();
  await new Promise((r) => setTimeout(r, 150));
  const events = await readEvents(agent.log.filePath);
  const out = {
    finals: events.filter((e) => e.type === "message" && (e.data as { final?: boolean })?.final === true).length,
    status: (agent as unknown as { goal: { status: string } }).goal.status,
    queued: (agent as unknown as { pendingPrompts: unknown[] }).pendingPrompts.length,
  };
  await agent.dispose();
  return out;
}

test("a REJECTED audit notifies nobody (#89)", async () => {
  await useTempDirs(["fa1-", "fa2-"], async ([ws, sd]) => {
    const r = await run(ws!, sd!, "CHANGES-REQUIRED: tests are missing");
    assert.equal(r.status, "active", "a rejected audit must leave the goal active (#89)");
    assert.equal(r.queued, 1, "and queue the gaps as the next instruction (#89)");
    assert.equal(
      r.finals,
      0,
      `a rejected finish must NOT emit final:true — that is the parent's notification (#89); got ${r.finals}`,
    );
  });
});

test("an APPROVED audit still notifies the parent (#89)", async () => {
  // the regression this fix could have caused: a legitimate finish must still
  // reach the parent, or no sub-agent would ever report
  await useTempDirs(["fa3-", "fa4-"], async ([ws, sd]) => {
    const r = await run(ws!, sd!, "APPROVED: everything checks out");
    assert.equal(r.status, "done", "an approved audit completes the goal (#89)");
    assert.equal(r.finals, 1, "and the parent must be told exactly once (#89)");
  });
});

test("the rejection is still recorded for the operator (#89)", async () => {
  // returning early must not swallow the audit trail
  await useTempDirs(["fa5-", "fa6-"], async ([ws, sd]) => {
    let call = 0;
    const agent = new Agent({
      id: "child",
      parent: "p",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async () => {
        call++;
        if (call === 1) return { message: { role: "assistant" as const, content: "w" } };
        if (call === 2)
          return {
            message: {
              role: "assistant" as const,
              content: "",
              tool_calls: [
                {
                  id: "f1",
                  type: "function" as const,
                  function: { name: "finish", arguments: JSON.stringify({ goalComplete: true, summary: "s" }) },
                },
              ],
            },
          };
        return { message: { role: "assistant" as const, content: "CHANGES-REQUIRED: gaps here" } };
      },
      autoContinue: false,
    } as never) as Agent;
    await agent.init();
    await agent.setGoal("g");
    (agent as unknown as { goal: { verify?: string } }).goal.verify = "must hold";
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    await agent.settled();
    await new Promise((r) => setTimeout(r, 150));
    const events = await readEvents(agent.log.filePath);
    assert.ok(
      events.some((e) => e.type === "goal" && (e.data as { event?: string })?.event === "audit-started"),
      "the audit must be recorded (#89)",
    );
    assert.ok(
      events.some(
        (e) =>
          e.type === "message" &&
          String((e.data as { operatorFacing?: boolean; content?: string })?.content ?? "").includes(
            "CHANGES REQUIRED",
          ),
      ),
      "and the verdict shown, operator-facing (#89)",
    );
    await agent.dispose();
  });
});
