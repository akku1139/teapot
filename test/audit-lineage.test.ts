/**
 * #91 / #94 — FINAL が監査とどう関係したかが event 自体に記録されていない。
 *
 * v0.28.1 の final event は `{ role, final: true, content, recentContext }` で、
 * audit は別の goal event に分かれている。log reader は
 * audit-started / audit / FINAL を近接して見て「推測」するしかなく、rejected
 * attempt を跨いだ最終 final は「最初に何がダメで、何を直したのか」を運ばない。
 *
 * Required:
 *   - approved を経た final は `audited: true` / `auditVerdict` /
 *     `auditAttempt` を持つ
 *   - rejected attempt を跨いだ final は `previousAuditVerdict` /
 *     `previousAuditFeedback` も持つ（attempt 2 の approved なら 2 と書いてある）
 *   - 監査なしの finish は監査 metadata を持たない
 *   - UNVERIFIED で受理された final（#128 の capped 経路）は
 *     `auditVerdict: "unavailable"` として騙らない
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Lineage {
  finals: { audited?: boolean; auditVerdict?: string; auditAttempt?: number; previousAuditVerdict?: string; previousAuditFeedback?: string; content: string }[];
}

async function runLineage(
  ws: string,
  sd: string,
  auditReplies: string[],
  withVerify: boolean,
): Promise<Lineage> {
  let call = 0;
  let auditIdx = 0;
  const agent = new Agent({
    id: "c",
    parent: "p",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      call++;
      if (call === 1) return { message: { role: "assistant", content: "work" } } as never;
      if (call === 2)
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "f1", type: "function", function: { name: "finish", arguments: JSON.stringify({ goalComplete: true, summary: "the report" }) } },
            ],
          },
        } as never;
      return { message: { role: "assistant", content: auditReplies[Math.min(auditIdx++, auditReplies.length - 1)] } } as never;
    },
    autoContinue: false,
  } as never) as Agent;
  try {
    await agent.init();
    await agent.setGoal("g");
    if (withVerify) (agent as unknown as { goal: { verify?: string } }).goal.verify = "must hold";
    agent.enqueuePrompt("go", "user");
    agent.start("t");
    await Promise.race([agent.settled(), wait(8000)]);
    await wait(150);
    const events = await readEvents(agent.log.filePath);
    return {
      finals: events
        .filter((e) => e.type === "message" && (e.data as { final?: boolean })?.final === true)
        .map((e) => e.data as Lineage["finals"][number]),
    };
  } finally {
    agent.stop("end");
    await Promise.race([agent.settled().catch(() => {}), wait(1000)]);
    await agent.dispose().catch(() => {});
  }
}

test("a final that survived the audit carries its verdict + attempt (#91/#94)", async () => {
  await useTempDirs(["al1-", "al2-"], async ([ws, sd]) => {
    const r = await runLineage(ws!, sd!, ["APPROVED: all checks pass"], true);
    assert.equal(r.finals.length, 1);
    const f = r.finals[0]!;
    assert.equal(f.audited, true, "the final must SAY it was audited (#91)");
    assert.equal(f.auditVerdict, "approved", "and with what verdict (#91)");
    assert.equal(f.auditAttempt, 1, "and on which attempt (#94)");
  });
});

test("a final after a REJECTED attempt carries the previous verdict + feedback (#94)", async () => {
  await useTempDirs(["al3-", "al4-"], async ([ws, sd]) => {
    const r = await runLineage(
      ws!, sd!,
      ["CHANGES-REQUIRED: the Kconfig symbol does not exist", "APPROVED: fixed and verified"],
      true,
    );
    const f = r.finals.at(-1)!;
    assert.equal(f.audited, true, "#91");
    assert.equal(f.auditVerdict, "approved", "#91");
    assert.equal(f.auditAttempt, 2, "the approving audit was attempt 2 (#94)");
    assert.equal(f.previousAuditVerdict, "changes-required", "what the first attempt was told (#94)");
    assert.equal(
      f.previousAuditFeedback,
      "the Kconfig symbol does not exist",
      "so the parent can see WHAT was wrong the first time (#94)",
    );
  });
});

test("a NEW goal must not inherit the previous goal's rejection lineage (#A2)", async () => {
  // goal1 gets rejected, then the operator sets goal2 in the same session.
  // goal2's FIRST approval must not carry goal1's changes-required as its
  // "previous" — and its attempt counter restarts at 1.
  await useTempDirs(["al9-", "al10-"], async ([ws, sd]) => {
    let call = 0;
    let audits = 0;
    const auditReplies = ["CHANGES-REQUIRED: fix the flibber", "APPROVED: ok now"];
    const agent = new Agent({
      id: "c",
      parent: "p",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        call++;
        if (call === 1) return { message: { role: "assistant", content: "work" } } as never;
        if (call === 2)
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "f1", type: "function", function: { name: "finish", arguments: JSON.stringify({ goalComplete: true, summary: "done" }) } },
              ],
            },
          } as never;
        audits++;
        return { message: { role: "assistant", content: auditReplies[Math.min(audits - 1, 1)] } } as never;
      },
      autoContinue: false,
    } as never) as Agent;
    try {
      await agent.init();
      await agent.setGoal("goal one");
      (agent as unknown as { goal: { verify?: string } }).goal.verify = "must hold";
      agent.enqueuePrompt("go", "user");
      agent.start("t");
      await Promise.race([agent.settled(), wait(8000)]);
      // goal2: a fresh contract in the same session
      await agent.setGoal("goal two");
      (agent as unknown as { goal: { verify?: string } }).goal.verify = "must hold";
      await agent.setGoalStatus("active");
      agent.enqueuePrompt("again", "user");
      agent.start("t");
      await Promise.race([agent.settled(), wait(8000)]);
      await wait(150);
      const events = await readEvents(agent.log.filePath);
      const finals = events
        .filter((e) => e.type === "message" && (e.data as { final?: boolean })?.final === true)
        .map((e) => e.data as Lineage["finals"][number]);
      const last = finals.at(-1)!;
      assert.equal(last.auditVerdict, "approved", "goal2 was approved");
      assert.equal(last.auditAttempt, 1, "the attempt counter restarted for the new goal (#A2)");
      assert.equal(
        last.previousAuditVerdict,
        undefined,
        "goal1's rejection must not ride along as goal2's previous (#A2)",
      );
    } finally {
      agent.stop("end");
      await Promise.race([agent.settled().catch(() => {}), wait(1000)]);
      await agent.dispose().catch(() => {});
    }
  });
});

test("an UNAUDITED final carries no audit metadata", async () => {
  await useTempDirs(["al5-", "al6-"], async ([ws, sd]) => {
    const r = await runLineage(ws!, sd!, [], false);
    assert.equal(r.finals.length, 1);
    const f = r.finals[0]!;
    assert.equal(f.audited, undefined, "no audit ran — the final must not claim one (#91)");
    assert.equal(f.auditVerdict, undefined, "#91");
  });
});

test("a capped-unaudited run emits NO final that could claim approval (#128 tie-in)", async () => {
  await useTempDirs(["al7-", "al8-"], async ([ws, sd]) => {
    // three unusable audits: the cap stops the retries with a loud note and
    // the goal stays ACTIVE — so no final may exist that could read as
    // approved (merged semantics: upstream's reject-cap philosophy)
    let call = 0;
    const agent = new Agent({
      id: "c",
      parent: "p",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        call++;
        if (call === 1) return { message: { role: "assistant", content: "work" } } as never;
        if (call % 2 === 0)
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: `f${call}`, type: "function", function: { name: "finish", arguments: JSON.stringify({ goalComplete: true, summary: "the report" }) } },
              ],
            },
          } as never;
        return { message: { role: "assistant", content: "looks fine to me" } } as never;
      },
      autoContinue: false,
    } as never) as Agent;
    try {
      await agent.init();
      await agent.setGoal("g");
      (agent as unknown as { goal: { verify?: string } }).goal.verify = "must hold";
      agent.enqueuePrompt("go", "user");
      agent.start("t");
      await Promise.race([agent.settled(), wait(8000)]);
      await wait(150);
      const events = await readEvents(agent.log.filePath);
      const finals = events
        .filter((e) => e.type === "message" && (e.data as { final?: boolean })?.final === true)
        .map((e) => e.data as Lineage["finals"][number]);
      assert.equal(finals.length, 0, "no final while the goal is active — the parent is never told a lie");
      assert.ok(
        events.some(
          (e) => e.type === "system_note" && (e.data as { event?: string }).event === "audit-unavailable-cap",
        ),
        "the cap is announced loudly (#128)",
      );
    } finally {
      agent.stop("end");
      await Promise.race([agent.settled().catch(() => {}), wait(1000)]);
      await agent.dispose().catch(() => {});
    }
  });
});
