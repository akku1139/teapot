import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

async function auditWith(
  ws: string,
  sd: string,
  reply: string,
): Promise<{
  verdict?: string;
  feedback: string;
  auditFailed: number;
  finals: number;
  status: string;
  queued: number;
}> {
  let call = 0;
  const agent = new Agent({
    id: "c",
    parent: "p",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      call++;
      if (call === 1) return { message: { role: "assistant" as const, content: "work" } };
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
                  arguments: JSON.stringify({ goalComplete: true, summary: "done" }),
                },
              },
            ],
          },
        };
      return { message: { role: "assistant" as const, content: reply } };
    },
    autoContinue: false,
  } as never) as Agent;
  await agent.init();
  await agent.setGoal("g");
  (agent as unknown as { goal: { verify?: string } }).goal.verify = "must hold";
  agent.enqueuePrompt("go", "user");
  agent.start("t");
  await agent.settled();
  await new Promise((r) => setTimeout(r, 120));
  const events = await readEvents(agent.log.filePath);
  const audit = events.find((e) => e.type === "goal" && (e.data as { event?: string })?.event === "audit");
  const out = {
    verdict: (audit?.data as { verdict?: string } | undefined)?.verdict,
    feedback: String((audit?.data as { feedback?: string } | undefined)?.feedback ?? ""),
    auditFailed: events.filter(
      (e) => e.type === "system_note" && (e.data as { event?: string })?.event === "audit-failed",
    ).length,
    finals: events.filter((e) => e.type === "message" && (e.data as { final?: boolean })?.final === true).length,
    status: (agent as unknown as { goal: { status: string } }).goal.status,
    queued: (agent as unknown as { pendingPrompts: unknown[] }).pendingPrompts.length,
  };
  await agent.dispose();
  return out;
}

test("an empty auditor reply is NOT a rejection (#90)", async () => {
  await useTempDirs(["av1-", "av2-"], async ([ws, sd]) => {
    const r = await auditWith(ws!, sd!, "");
    assert.equal(r.verdict, undefined, `no verdict may be recorded (#90); got ${r.verdict}`);
    assert.ok(r.auditFailed >= 1, "and it must be recorded as audit-failed (#90)");
    assert.equal(r.status, "active", "and it must NOT complete the goal (#128)");
    assert.equal(r.finals, 0, "and no final reaches the parent without a verdict (#128)");
  });
});

test("whitespace-only is not a verdict (#90)", async () => {
  await useTempDirs(["av3-", "av4-"], async ([ws, sd]) => {
    const r = await auditWith(ws!, sd!, "   \n  ");
    assert.equal(r.verdict, undefined, "#90");
    assert.ok(r.auditFailed >= 1, "#90");
    assert.equal(r.status, "active", "#128");
  });
});

test("provider placeholder text is not a verdict (#90)", async () => {
  for (const junk of ["(tool call)", "(no content)", "(no output)"]) {
    await useTempDirs(["av5-", "av6-"], async ([ws, sd]) => {
      const r = await auditWith(ws!, sd!, junk);
      assert.equal(r.verdict, undefined, `${junk} must not be scored as a verdict (#90)`);
      assert.ok(r.auditFailed >= 1, `${junk} must record audit-failed (#90)`);
      assert.equal(r.status, "active", `${junk} must not complete the goal (#128)`);
    });
  }
});

test("a real rejection still rejects, with its reason (#90)", async () => {
  await useTempDirs(["av7-", "av8-"], async ([ws, sd]) => {
    const r = await auditWith(ws!, sd!, "CHANGES-REQUIRED: the Kconfig symbol does not exist");
    assert.equal(r.verdict, "changes-required", "a genuine verdict must be honoured (#90)");
    assert.equal(r.feedback, "the Kconfig symbol does not exist", "and its reason kept (#90)");
    assert.equal(r.queued, 1, "and the gaps handed back for a retry (#90)");
    assert.equal(r.status, "active", "with the goal still active (#90)");
  });
});

test("an approval still completes and notifies the parent (#90)", async () => {
  await useTempDirs(["av9-", "av10-"], async ([ws, sd]) => {
    const r = await auditWith(ws!, sd!, "APPROVED: everything checks out");
    assert.equal(r.verdict, "approved", "#90");
    assert.equal(r.status, "done", "an approved audit completes the goal (#90)");
    assert.equal(r.finals, 1, "and the parent is told exactly once (#90)");
  });
});

test("a reply with text but no verdict keyword is not a verdict (#90)", async () => {
  await useTempDirs(["av11-", "av12-"], async ([ws, sd]) => {
    const r = await auditWith(ws!, sd!, "I think the work looks fine overall.");
    assert.equal(r.verdict, undefined, "prose is not a verdict (#90)");
    assert.ok(r.auditFailed >= 1, "#90");
    assert.equal(r.status, "active", "and the goal is NOT completed by prose (#128)");
  });
});
