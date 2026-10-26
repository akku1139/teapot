import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { dataOf } from "./helpers/event-data.ts";

type Call = "work" | "audit";

function rejectingPair(ws: string, sd: string, cap?: number) {
  const calls: Call[] = [];
  let auditHistory: { role: string; toolCalls: boolean; toolCallId: string | null }[] | null = null;
  let n = 0;
  const a = new Agent({
    id: "c",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (_l: unknown, msgs: unknown) => {
      n++;
      const list = msgs as { role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string }[];
      const isAudit = list.some((m) => m.role === "user" && /APPROVED/.test(String(m.content ?? "")));
      if (isAudit) {
        calls.push("audit");
        if (!auditHistory)
          auditHistory = list.map((m) => ({
            role: m.role,
            toolCalls: !!m.tool_calls?.length,
            toolCallId: m.tool_call_id ?? null,
          }));
        return { message: { role: "assistant" as const, content: "CHANGES-REQUIRED: still wrong" } };
      }
      calls.push("work");
      return {
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            { id: `f${n}`, type: "function" as const, function: { name: "finish", arguments: JSON.stringify({ goalComplete: true, summary: "s" }) } },
          ],
        },
      };
    },
    autoContinue: false,
    maxAuditRejects: cap,
  } as never) as Agent;
  return { a, calls, getAuditHistory: () => auditHistory };
}

test("the auditor gets its OWN conversation, not the worker's (#128)", async () => {
  await useTempDirs(["t128a-", "t128b-"], async ([ws, sd]) => {
    const { a, getAuditHistory } = rejectingPair(ws!, sd!);
    await a.init();
    await a.setGoal("g");
    await a.setGoalVerify("v");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const h = getAuditHistory() ?? [];
      assert.equal(h.length, 1, `the auditor starts from a single prepared turn: ${JSON.stringify(h)}`);
      assert.equal(h[0]?.role, "user", "and it is a user turn (#128)");
      assert.ok(
        !h.some((m) => m.toolCalls),
        "the worker's tool calls must NOT reach the auditor — that is what made it continue the work (#128)",
      );
      assert.ok(
        !h.some((m) => m.role === "tool"),
        "and neither must the worker's tool results (#128)",
      );
    } finally {
      a.stop("done");
      await a.settled().catch(() => {});
    }
  });
});

test("a rejected audit retries, and is BOUNDED (#128)", async () => {
  await useTempDirs(["t128c-", "t128d-"], async ([ws, sd]) => {
    const { a, calls } = rejectingPair(ws!, sd!, 2);
    await a.init();
    await a.setGoal("g");
    await a.setGoalVerify("v");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const audits = calls.filter((c) => c === "audit").length;
      assert.ok(audits > 1, `a rejection must be retried, not silently dropped (#128); got ${audits}`);
      assert.ok(audits <= 4, `and the retry must be BOUNDED (#128); got ${audits} audit calls`);
    } finally {
      a.stop("done");
      await a.settled().catch(() => {});
    }
  });
});

test("the bound is a log note, and the goal stays ACTIVE (#128)", async () => {
  await useTempDirs(["t128e-", "t128f-"], async ([ws, sd]) => {
    const { a } = rejectingPair(ws!, sd!, 1);
    await a.init();
    await a.setGoal("g");
    await a.setGoalVerify("v");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const events = await readEvents(`${sd}/chat.jsonl`);
      assert.ok(
        events.some((e) => dataOf(e).event === "audit-retry-cap"),
        "hitting the cap must be visible in the log (#128)",
      );
      const finals = events.filter((e) => e.type === "message" && dataOf(e).final);
      assert.equal(finals.length, 0, "a rejected finish must never be reported as final (#89/#128)");
    } finally {
      a.stop("done");
      await a.settled().catch(() => {});
    }
  });
});

test("an APPROVED audit still finishes normally (#128)", async () => {
  await useTempDirs(["t128g-", "t128h-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "c",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (_l: unknown, msgs: unknown) => {
        const list = msgs as { role: string; content?: string }[];
        if (list.some((m) => m.role === "user" && /APPROVED/.test(String(m.content ?? ""))))
          return { message: { role: "assistant" as const, content: "APPROVED: correct" } };
        return {
          message: {
            role: "assistant" as const,
            content: "",
            tool_calls: [{ id: "f1", type: "function" as const, function: { name: "finish", arguments: JSON.stringify({ goalComplete: true, summary: "s" }) } }],
          },
        };
      },
      autoContinue: false,
    } as never) as Agent;
    await a.init();
    await a.setGoal("g");
    await a.setGoalVerify("v");
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const events = await readEvents(`${sd}/chat.jsonl`);
      assert.equal(
        events.filter((e) => e.type === "message" && dataOf(e).final).length,
        1,
        "an approved audit must produce exactly one final (#128)",
      );
      assert.equal(
        events.filter((e) => dataOf(e).event === "audit-retry-cap").length,
        0,
        "and must not touch the retry cap (#128)",
      );
    } finally {
      a.stop("done");
      await a.settled().catch(() => {});
    }
  });
});
