/**
 * #128 — the completion audit's control flow.
 *
 * Two defects, both found by MEASURING rather than reading, and the second is
 * worse than the one the report described.
 *
 * ## 1. The auditor received an INVALID tool-call history
 *
 * The finish branch called `handleFinish()` — which calls the auditor with
 * `buildMessages()` — BEFORE `answerMeta(call, …)`. So at audit time the history
 * ended at an assistant message carrying `tool_calls: [finish]` with no matching
 * `tool` message. Measured, that is exactly what the auditor got:
 *
 *     system  user  assistant(tool_calls)  user(audit prompt)
 *
 * OpenAI-compatible providers require every tool_call to be answered, and a
 * strict one rejects the request. So a CHANGES-REQUIRED audit would fail with a
 * PROTOCOL error instead of returning a verdict — and #128's fail-open would then
 * mark the goal done. The bug made the whole audit unreliable exactly when it
 * mattered.
 *
 * ## 2. The reject loop was UNBOUNDED (not, as reported, "never continues")
 *
 * The report says a rejected audit never retries because the caller sets
 * `finished = true`. Measured against the real Agent, it DOES retry — because
 * `if (this.pendingPrompts.length) continue;` runs first. But nothing bounds it:
 *
 *     work -> audit -> work -> audit -> ...  =  381 audit calls in one turn
 *
 * `maxConsecutiveIdleRounds` counts IDLE rounds, and a rejection is not idle.
 * `maxTurnsPerRound` only LOGS `round-turn-cap`; it does not break, and a
 * rejection never ends the round.
 *
 * So the real cost is unbounded provider spend on a goal the auditor keeps
 * refusing. Bounded at 3 by default, and the goal is deliberately left ACTIVE —
 * marking it done would be #128's own fail-open complaint all over again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

type Call = "work" | "audit";

/** an agent whose auditor always rejects, and which always tries to finish */
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

test("the auditor receives an ANSWERED tool call (#128)", async () => {
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
      const assistant = h.find((m) => m.toolCalls);
      const tool = h.find((m) => m.role === "tool");
      assert.ok(assistant, `the finish call must be in the auditor's history (#128): ${JSON.stringify(h)}`);
      assert.ok(
        tool,
        `every tool_call must be answered before the audit LLM call (#128): ${JSON.stringify(h)}`,
      );
      // and the tool message must come AFTER the assistant that asked for it,
      // or it answers nothing
      assert.ok(
        h.indexOf(tool) > h.indexOf(assistant),
        `the tool message must follow the assistant tool_call (#128): ${JSON.stringify(h)}`,
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
  // #128's own complaint: "could not be audited" silently became "passed".
  // Marking a repeatedly-rejected goal DONE would be the same failure.
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
        events.some((e) => e.data?.event === "audit-retry-cap"),
        "hitting the cap must be visible in the log (#128)",
      );
      const finals = events.filter((e) => e.type === "message" && e.data?.final);
      assert.equal(finals.length, 0, "a rejected finish must never be reported as final (#89/#128)");
    } finally {
      a.stop("done");
      await a.settled().catch(() => {});
    }
  });
});

test("an APPROVED audit still finishes normally (#128)", async () => {
  // the cap must not break the happy path
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
        events.filter((e) => e.type === "message" && e.data?.final).length,
        1,
        "an approved audit must produce exactly one final (#128)",
      );
      assert.equal(
        events.filter((e) => e.data?.event === "audit-retry-cap").length,
        0,
        "and must not touch the retry cap (#128)",
      );
    } finally {
      a.stop("done");
      await a.settled().catch(() => {});
    }
  });
});
