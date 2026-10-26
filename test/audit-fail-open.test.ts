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
  retries: number;
  queued: number;
  unavailableCap: number;
}

async function runAudit(
  ws: string,
  sd: string,
  mode: "empty" | "throw" | "capped",
): Promise<AuditRun> {
  let call = 0;
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
    chatFn: async (cfg: unknown, messages: { role?: string; content?: string }[]) => {
      call++;
      const askingAuditor = messages.some((m) => /completion AUDITOR/i.test(String(m.content ?? "")));
      if (askingAuditor) return unusable();
      const retries = messages.filter(
        (m) => m.role === "user" && /completion audit could not/i.test(String(m.content ?? "")),
      ).length;
      const sawFinish = messages.some(
        (m) => m.role === "tool" && /goalComplete/i.test(String(m.content ?? "")),
      );
      if (retries >= 2) return { message: { role: "assistant" as const, content: "waiting for the operator" } };
      if (!sawFinish && call === 1) return { message: { role: "assistant" as const, content: "work" } };
      return finishCall();
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
      retries: events.filter(
        (e) => e.type === "prompt" && /completion audit could not/i.test(String((e.data as { text?: string })?.text ?? "")),
      ).length,
      queued: (agent as unknown as { pendingPrompts: unknown[] }).pendingPrompts.length,
      unavailableCap: caps.length,
    };
  } finally {
    agent.stop("end");
    await Promise.race([agent.settled().catch(() => {}), wait(1000)]);
    await agent.dispose().catch(() => {});
  }
}

test("an empty auditor reply does NOT complete the goal (#128)", async () => {
  await useTempDirs(["afo1-", "afo2-"], async ([ws, sd]) => {
    const r = await runAudit(ws!, sd!, "empty");
    assert.equal(r.status, "active", `「監査できなかった」は done ではない (#128); got ${r.status}`);
    assert.equal(r.finals, 0, "no verdict → no final to the parent (#128)");
    assert.ok(r.auditFailed >= 1, "recorded as audit-failed (#128) — the exact count is stub-dependent (the sub-report nudge can re-finish)");
    assert.ok(r.retries >= 1, `a self-verify retry is issued (#128); got ${r.retries}`);
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

test("a permanently unavailable auditor cannot trap the worker forever (#128)", async () => {
  await useTempDirs(["afo5-", "afo6-"], async ([ws, sd]) => {
    const r = await runAudit(ws!, sd!, "capped");
    assert.equal(r.status, "active", "the goal stays ACTIVE at the cap — never silently done (#128)");
    assert.equal(r.finals, 0, "no final while the goal is active (#89: the parent is not told a lie)");
    assert.ok(r.auditFailed >= 3, "every failed attempt is on the record (#128)");
    assert.equal(r.unavailableCap, 1, "the cap is announced with a loud note the operator can see (#128)");
    assert.equal(r.retries, 2, "retries stop at the cap — the loop does not continue (#128)");
    assert.equal(r.queued, 0, "and nothing is left waiting (#128)");
  });
});

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