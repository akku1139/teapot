/**
 * #90 — an auditor reply that is not a verdict was scored as a rejection.
 *
 * `/^APPROVED\b/i.test("")` is false, so an auditor that returned nothing —
 * truncated, refused, or leaking provider tool-call markup — produced
 * `changes-required` with an EMPTY reason. The worker was then told to "address
 * these gaps" while being given none, with the fallback text being the
 * verification contract it had already read.
 *
 * Observed in `tyb2-5-sub-sound-deep-dive-4c13c187`: seven consecutive
 * reason-less rejections, 424 tool calls, 8 FINAL messages. The worker's own
 * summaries say it: *"Seven rejections with no stated gap."*
 *
 * A reason-less rejection carries no information. It is now treated as NO
 * VERDICT and fails open — the same treatment the `catch` already gives an
 * auditor that threw, for the same reason: a flaky provider must not be able to
 * trap work in an unauditable loop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

/** drive one child: work → finish(goalComplete) → audit with `reply` */
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

/* ---------- the bug ---------- */

test("an empty auditor reply is NOT a rejection (#90)", async () => {
  await useTempDirs(["av1-", "av2-"], async ([ws, sd]) => {
    const r = await auditWith(ws!, sd!, "");
    assert.equal(r.verdict, undefined, `no verdict may be recorded (#90); got ${r.verdict}`);
    assert.equal(r.auditFailed, 1, "and it must be recorded as audit-failed (#90)");
    assert.equal(r.queued, 0, "no reason-less retry may be queued (#90)");
  });
});

test("whitespace-only is not a verdict (#90)", async () => {
  await useTempDirs(["av3-", "av4-"], async ([ws, sd]) => {
    const r = await auditWith(ws!, sd!, "   \n  ");
    assert.equal(r.verdict, undefined, "#90");
    assert.equal(r.auditFailed, 1, "#90");
  });
});

test("provider placeholder text is not a verdict (#90)", async () => {
  // the real session recorded feedback "(tool call)" — the provider leaked its
  // tool-call markup as plain text. Treating that as a REASON is worse than
  // treating it as nothing, because it reads like a real critique.
  for (const junk of ["(tool call)", "(no content)", "(no output)"]) {
    await useTempDirs(["av5-", "av6-"], async ([ws, sd]) => {
      const r = await auditWith(ws!, sd!, junk);
      assert.equal(r.verdict, undefined, `${junk} must not be scored as a verdict (#90)`);
      assert.equal(r.auditFailed, 1, `${junk} must record audit-failed (#90)`);
      assert.equal(r.queued, 0, `${junk} must not queue a retry (#90)`);
    });
  }
});

/* ---------- the behaviours that must survive ---------- */

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
  // the regression this fix could have caused: if an unusable reply failed open,
  // a genuine approval must still work, or nothing would ever finish
  await useTempDirs(["av9-", "av10-"], async ([ws, sd]) => {
    const r = await auditWith(ws!, sd!, "APPROVED: everything checks out");
    assert.equal(r.verdict, "approved", "#90");
    assert.equal(r.status, "done", "an approved audit completes the goal (#90)");
    assert.equal(r.finals, 1, "and the parent is told exactly once (#90)");
  });
});

test("a reply with text but no verdict keyword is not a verdict (#90)", async () => {
  // e.g. the model replied with prose instead of the required one line
  await useTempDirs(["av11-", "av12-"], async ([ws, sd]) => {
    const r = await auditWith(ws!, sd!, "I think the work looks fine overall.");
    assert.equal(r.verdict, undefined, "prose is not a verdict (#90)");
    assert.equal(r.auditFailed, 1, "#90");
  });
});
