/**
 * #128 — audit failure が completion に fail-open している。
 *
 * 上流の #128 対応（reject ループの bound + 監査履歴修正）に加え、この PR は
 * **verdict にならない reply / auditor の例外**の経路を fail-closed にする:
 * 「監査できなかった」≠「監査に合格した」。goal は active のまま自己再検証を
 * 求め、連続3回で大声の note とともに停止する（上流の reject-cap と同じ哲学 —
 * done には決してしない。オペレーターが判断する）。
 *
 * Required:
 *   APPROVED          → done + final
 *   CHANGES-REQUIRED  → active + retry (既存, #89)
 *   "" / prose / throw → NOT done, NOT final, audit-failed 記録, 自己検証 retry
 *   3回連続 unavailable → goal は ACTIVE のまま、audit-unavailable-cap を記録、
 *                        リトライ停止（final は出さない — goal が active のため）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AuditRun {
  status: string;
  finals: number;
  auditFailed: number;
  auditFailedDetails: string[];
  queued: number;
  unavailableCap: number;
}

/** drive one child: work → finish(goalComplete) → audit with `mode` */
async function runAudit(
  ws: string,
  sd: string,
  mode: "empty" | "throw" | "capped",
): Promise<AuditRun> {
  let call = 0;
  // NOTE: does NOT bump `call` — the parity of the capped mode depends on one
  // increment per chat call (audit calls land on odd counts)
  const unusable = () => {
    if (mode === "throw") throw new Error("provider exploded");
    return { message: { role: "assistant" as const, content: "I think the work looks fine overall." } };
  };
  const finishCall = () => ({
    message: {
      role: "assistant" as const,
      content: "",
      tool_calls: [
        {
          id: `f${call}`,
          type: "function" as const,
          function: { name: "finish", arguments: JSON.stringify({ goalComplete: true, summary: "done" }) },
        },
      ],
    },
  });
  const agent = new Agent({
    id: "c",
    parent: "p",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      call++;
      // capped: work → finish → audit×3(unusable each time) → cap stops the retries
      if (mode === "capped") {
        if (call === 1) return { message: { role: "assistant" as const, content: "work" } };
        if (call % 2 === 0) return finishCall();
        return unusable();
      }
      if (call === 1) return { message: { role: "assistant" as const, content: "work" } };
      if (call === 2) return finishCall();
      return unusable();
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
    const failures = events.filter(
      (e) => e.type === "system_note" && (e.data as { event?: string }).event === "audit-failed",
    );
    const caps = events.filter(
      (e) => e.type === "system_note" && (e.data as { event?: string }).event === "audit-unavailable-cap",
    );
    return {
      status: (agent as unknown as { goal: { status: string } }).goal.status,
      finals: events.filter((e) => e.type === "message" && (e.data as { final?: boolean })?.final === true).length,
      auditFailed: failures.length,
      auditFailedDetails: failures.map((e) => String((e.data as { detail?: string }).detail ?? "")),
      queued: (agent as unknown as { pendingPrompts: unknown[] }).pendingPrompts.length,
      unavailableCap: caps.length,
    };
  } finally {
    agent.stop("end");
    await Promise.race([agent.settled().catch(() => {}), wait(1000)]);
    await agent.dispose().catch(() => {});
  }
}

/* ---------- the fail-open bug ---------- */

test("an empty auditor reply does NOT complete the goal (#128)", async () => {
  await useTempDirs(["afo1-", "afo2-"], async ([ws, sd]) => {
    const r = await runAudit(ws!, sd!, "empty");
    assert.equal(r.status, "active", `「監査できなかった」は done ではない (#128); got ${r.status}`);
    assert.equal(r.finals, 0, "no verdict → no final to the parent (#128)");
    assert.ok(r.auditFailed >= 1, "recorded as audit-failed (#128) — the exact count is stub-dependent (the sub-report nudge can re-finish)");
    assert.equal(r.queued, 1, "a self-verify retry is queued (#128)");
  });
});

test("an auditor that THROWS is not treated as approved (#128)", async () => {
  await useTempDirs(["afo3-", "afo4-"], async ([ws, sd]) => {
    const r = await runAudit(ws!, sd!, "throw");
    assert.equal(r.status, "active", "a provider error must not mark the goal done (#128)");
    assert.equal(r.finals, 0, "#128");
    assert.ok(r.auditFailed >= 1, "the failure is recorded (#128)");
  });
});

/* ---------- the bounded fallback (upstream's philosophy: leave it ACTIVE, loudly) ---------- */

test("a permanently unavailable auditor cannot trap the worker forever (#128)", async () => {
  await useTempDirs(["afo5-", "afo6-"], async ([ws, sd]) => {
    const r = await runAudit(ws!, sd!, "capped");
    assert.equal(r.status, "active", "the goal stays ACTIVE at the cap — never silently done (#128)");
    assert.equal(r.finals, 0, "no final while the goal is active (#89: the parent is not told a lie)");
    assert.ok(r.auditFailed >= 3, "every failed attempt is on the record (#128)");
    assert.equal(r.unavailableCap, 1, "the cap is announced with a loud note the operator can see (#128)");
    assert.equal(r.queued, 0, "no further retry prompt — the loop stopped (#128)");
  });
});

/* ---------- the verdicts that must keep working (#89/#90) ---------- */

test("an approval still completes and notifies the parent", async () => {
  await useTempDirs(["afo7-", "afo8-"], async ([ws, sd]) => {
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
        if (call === 2) return {
          message: {
            role: "assistant" as const,
            content: "",
            tool_calls: [
              {
                id: "f1",
                type: "function" as const,
                function: { name: "finish", arguments: JSON.stringify({ goalComplete: true, summary: "done" }) },
              },
            ],
          },
        };
        return { message: { role: "assistant" as const, content: "APPROVED: everything checks out" } };
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
      assert.equal((agent as unknown as { goal: { status: string } }).goal.status, "done", "approved → done");
      assert.equal(
        events.filter((e) => e.type === "message" && (e.data as { final?: boolean })?.final === true).length,
        1,
        "the parent is told exactly once",
      );
    } finally {
      agent.stop("end");
      await Promise.race([agent.settled().catch(() => {}), wait(1000)]);
      await agent.dispose().catch(() => {});
    }
  });
});