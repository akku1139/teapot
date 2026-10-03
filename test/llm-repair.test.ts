/**
 * #50 — "`⚠ LLM API returned no choices`" — reported as "seems to happen in a
 * session that RESUMES after a teapot restart, details unknown".
 *
 * `LLM API returned no choices` is the one error this harness raises on a
 * SUCCESSFUL HTTP 200: the endpoint answered, but `choices` was missing. A
 * gateway answers a malformed chat-completions request that way far more often
 * than with a clean 400, so the report's "after a restart" is the tell — the
 * history rebuilt from chat.jsonl is a shape no live run produces.
 *
 * The specific shape: the completion AUDIT (goal `verify:` contract) asks the
 * model for a verdict in a side conversation that is NOT part of this.messages,
 * then writes the verdict to the log as a plain assistant `message` event. The
 * live run therefore never carries that message, but restoreFromLog() replays
 * every logged `message` — so after a restart the audit verdict reappears in
 * the conversation as if the agent had said it. From there the request carries
 * an assistant turn that answers nothing and a following prompt that answers
 * nothing, which is exactly the sort of thing a gateway drops on the floor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import { readFileSync } from "node:fs";
import type { ChatMessage, LlmResult } from "../src/agent/llm.ts";

const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (content: string, calls?: ReturnType<typeof tc>[]): LlmResult => ({
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
});

function mkAgent(ws: string, sessionDir: string, chatFn: any): Agent {
  return new Agent({
    id: "t",
    workspace: ws,
    sessionDir,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
    chatFn,
    autoContinue: false,
    restoreSession: true,
  } as any);
}

/**
 * Provider-shaped request check. A real endpoint answers a malformed message
 * array with a 200 and (often) zero choices — the bug report — so the mock
 * stands in for the thing that would otherwise be invisible.
 */
function providerReject(messages: ChatMessage[]): string | null {
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const m of messages) for (const t of m.tool_calls ?? []) called.add(t.id);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool") {
      if (!called.has(m.tool_call_id!)) return `tool result "${m.tool_call_id}" answers nothing`;
      if (answered.has(m.tool_call_id!)) return `duplicate tool result "${m.tool_call_id}"`;
      if (messages[i - 1]?.role !== "assistant") return "tool message not directly after its assistant turn";
      answered.add(m.tool_call_id!);
    }
  }
  const orphans = [...called].filter((id) => !answered.has(id));
  return orphans.length ? `unanswered tool_call(s): ${orphans.join(", ")}` : null;
}

const AUDIT_MARK = "completion audit:";

/** assistant tool_calls with no result, and tool results with no call */
function audit(msgs: ChatMessage[]): { orphanResults: string[]; orphanCalls: string[] } {
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const m of msgs) {
    for (const t of m.tool_calls ?? []) called.add(t.id);
    if (m.tool_call_id) answered.add(m.tool_call_id);
  }
  return {
    orphanResults: [...answered].filter((id) => !called.has(id)),
    orphanCalls: [...called].filter((id) => !answered.has(id)),
  };
}

/* ---------- the bug ---------- */

test("a restarted session does not replay the completion audit into the conversation (#50)", async () => {
  await useTempDirs(["a50a-", "a50b-"], async ([ws, sessionDir]) => {
    let turn = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      const sys = String(messages[0]?.content ?? "");
      // The auditor is a separate, tools-less call. Identify it by its PROMPT,
      // not by the absence of tool calls: by the time the audit runs, the
      // worker's own set_goal/finish calls are in the history, so the old
      // "no tool calls anywhere" test never matched and the auditor fell
      // through to a prose reply (#90).
      if (String(messages.at(-1)?.content ?? "").includes("independent completion AUDITOR")) {
        return reply("APPROVED: the work is genuinely complete");
      }
      turn++;
      if (turn === 1)
        return reply("calling finish", [
          tc("f1", "set_goal", { text: "ship the feature", verify: "npm test passes" }),
        ]);
      if (turn === 2)
        return reply("done", [tc("f2", "finish", { goalComplete: true, summary: "shipped it" })]);
      return reply("ok");
    };

    const first = mkAgent(ws, sessionDir, chatFn);
    await first.init();
    first.enqueuePrompt("go");
    first.start("t");
    await first.settled();
    await first.dispose();

    const logged = await readEvents(first.log.filePath);
    const auditEvents = logged.filter(
      (e) => e.type === "message" && String((e.data as any).content ?? "").includes(AUDIT_MARK),
    );
    assert.equal(
      auditEvents.length,
      1,
      `fixture must produce one audit message event, got ${auditEvents.length}`,
    );
    assert.equal(
      (first.messages as ChatMessage[]).some((m) => String(m.content ?? "").includes(AUDIT_MARK)),
      false,
      "the live history must NOT carry the audit verdict (it was a side conversation)",
    );

    // the restart: same session dir, fresh agent
    const second = mkAgent(ws, sessionDir, chatFn);
    await second.init();
    second.enqueuePrompt("anything else?");
    second.start("t");
    await second.settled();

    const leaked = (second.messages as ChatMessage[]).filter((m) =>
      String(m.content ?? "").includes(AUDIT_MARK),
    );
    assert.deepEqual(
      leaked.map((m) => m.role),
      [],
      `the audit verdict came back into the model's history after a restart (#50): ${JSON.stringify(leaked[0]?.content ?? "")}`,
    );
    await second.dispose();
  });
});

test("a restarted session's next request is one a provider accepts (#50)", async () => {
  await useTempDirs(["a50c-", "a50d-"], async ([ws, sessionDir]) => {
    const rejected: (string | null)[] = [];
    let turn = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      const last = String(messages.at(-1)?.content ?? "");
      if (last.includes("independent completion AUDITOR")) return reply("APPROVED: verified");
      rejected.push(providerReject(messages));
      turn++;
      if (turn === 1) return reply("calling finish", [tc("f1", "finish", { summary: "ok" })]);
      return reply("fine");
    };

    const first = mkAgent(ws, sessionDir, chatFn);
    await first.init();
    first.enqueuePrompt("go");
    first.start("t");
    await first.settled();
    await first.dispose();

    const second = mkAgent(ws, sessionDir, chatFn);
    await second.init();
    second.enqueuePrompt("next");
    second.start("t");
    await second.settled();

    assert.deepEqual(
      rejected.filter(Boolean),
      [],
      `restored history was rejected by the provider mock (#50): ${rejected.find(Boolean)}`,
    );
    await second.dispose();
  });
});

/* ---------- the contract scenario: a REAL tool, a restart, a resumed turn --- */

/**
 * The reported shape end to end, with nothing stubbed but the provider: the
 * agent runs a real tool, teapot restarts, and the operator sends another
 * message. Every request the SECOND incarnation makes — the one built from the
 * rebuilt history — is checked against a provider that rejects malformed
 * message arrays, which is what turns into a 200 with zero choices (#50).
 */
test("a real tool call survives a restart and the resumed turn stays valid (#50)", async () => {
  await useTempDirs(["a50i-", "a50j-"], async ([ws, sessionDir]) => {
    const rejected: (string | null)[] = [];
    const sawResult: string[] = [];
    let resumed = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      // only judge requests that carry real conversation (not the auditor's
      // tools-less side conversation, which is legitimately built on top)
      const last = String(messages.at(-1)?.content ?? "");
      if (!last.includes("independent completion AUDITOR")) rejected.push(providerReject(messages));
      if (last === "and now?") resumed++;
      // the tool result is present in the request ONLY if it really executed
      const executed = messages.some(
        (m: ChatMessage) => m.role === "tool" && /note\.txt/.test(String(m.content ?? "")),
      );
      if (executed) {
        sawResult.push("ran");
        return reply("all done");
      }
      return reply("writing", [tc("w1", "write_file", { path: "note.txt", content: "hello" })]);
    };

    const first = mkAgent(ws, sessionDir, chatFn);
    await first.init();
    first.enqueuePrompt("write a note");
    first.start("t");
    await first.settled();
    await first.dispose();
    assert.ok(sawResult.length, "the fixture must actually execute a tool (#50)");

    // --- restart: brand-new Agent over the SAME session dir ---
    const second = mkAgent(ws, sessionDir, chatFn);
    await second.init();
    second.enqueuePrompt("and now?");
    second.start("t");
    await second.settled();

    assert.equal(resumed, 1, "the resumed incarnation must run exactly one turn (#50)");
    assert.deepEqual(
      rejected.filter(Boolean),
      [],
      `a resumed session produced a request a provider would reject (#50): ${rejected.find(Boolean)}`,
    );
    // the restored history must still contain the tool exchange, not have lost it
    assert.ok(
      (second.messages as ChatMessage[]).some((m) => m.role === "tool"),
      "the tool result must survive the restart — otherwise the pair is broken (#50)",
    );
    await second.dispose();
  });
});

/* ---------- the OTHER timeline-only artefact: an empty assistant turn ----- */

/**
 * A kill mid-stream can leave an assistant `message` event with empty content
 * and no tool calls — the model streamed nothing before teapot died. The live
 * run never had such a turn in `messages` (the abort path pushes the partial
 * only when there IS one), but the restore replays it as a real assistant
 * utterance.
 *
 * Then sanitize() does what it must to keep providers happy: an assistant
 * message with blank content becomes the literal string "(no content)". So the
 * agent is sent a sentence it never said, attributed to itself. That is a
 * history shape no live run produces, which is the same class of thing that
 * comes back as a 200 with no choices (#50).
 */
test("a restored session drops an empty assistant turn instead of inventing one (#50)", async () => {
  await useTempDirs(["a50k-", "a50l-"], async ([ws, sessionDir]) => {
    const sent: ChatMessage[] = [];
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      for (const m of messages as ChatMessage[]) sent.push(m);
      return reply("ok");
    };

    const first = mkAgent(ws, sessionDir, chatFn);
    await first.init();
    first.enqueuePrompt("hello");
    first.start("t");
    await first.settled();
    // a turn that streamed nothing before the process died
    await first.log.append("message", first.snapshot().session, first.snapshot().branch, {
      role: "assistant",
      content: "",
    });
    await first.dispose();

    const second = mkAgent(ws, sessionDir, chatFn);
    await second.init();
    second.enqueuePrompt("still there?");
    second.start("t");
    await second.settled();

    const restored = second.messages as ChatMessage[];
    assert.equal(
      restored.some((m) => m.role === "assistant" && m.content === ""),
      false,
      "an empty assistant turn must not survive the restore (#50)",
    );
    // and nothing may be sent in its place either
    assert.equal(
      sent.some((m) => m.role === "assistant" && m.content === "(no content)"),
      false,
      `sanitize() would turn it into a sentence the agent never said (#50)`,
    );
    await second.dispose();
  });
});

test("an empty assistant turn that DID carry tool calls is kept (#50)", async () => {
  // The blank-content turn is only meaningless when it said nothing AT ALL.
  // A tool-calling turn legitimately has empty content (sanitize() replaces it
  // with "(tool call)"), and dropping it would orphan its tool results.
  await useTempDirs(["a50m-", "a50n-"], async ([ws, sessionDir]) => {
    const chatFn = async (): Promise<LlmResult> => reply("ok");
    const first = mkAgent(ws, sessionDir, chatFn);
    await first.init();
    first.enqueuePrompt("go");
    first.start("t");
    await first.settled();
    await first.log.append("message", first.snapshot().session, first.snapshot().branch, {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_real_1", name: "write_file" }],
    });
    await first.log.append("tool_result", first.snapshot().session, first.snapshot().branch, {
      callId: "call_real_1",
      name: "write_file",
      ok: true,
      result: "wrote the file",
    });
    await first.dispose();

    const second = mkAgent(ws, sessionDir, chatFn);
    await second.init();
    second.enqueuePrompt("next");
    second.start("t");
    await second.settled();

    const restored = second.messages as ChatMessage[];
    assert.ok(
      restored.some((m) => m.tool_calls?.some((t) => t.id === "call_real_1")),
      "a blank turn that issued tool calls must be kept — its results depend on it (#50)",
    );
    assert.ok(
      restored.some((m) => m.role === "tool" && m.tool_call_id === "call_real_1"),
      "…and so must its tool result (#50)",
    );
    await second.dispose();
  });
});

/* ---------- the guard that keeps it out ---------- */

test("an operator-facing message is skipped by the restore (#50)", async () => {
  // Same leak, reached without the auditor: any timeline-only assistant
  // `message` the live loop never put in `messages` must stay out of the
  // rebuilt history. `final: true` is already skipped; this pins the sibling
  // `operatorFacing` flag so a future "log it for the timeline" change cannot
  // smuggle a note back into the model's context.
  await useTempDirs(["a50e-", "a50f-"], async ([ws, sessionDir]) => {
    const first = mkAgent(ws, sessionDir, async () => reply("ok"));
    await first.init();
    first.enqueuePrompt("hi");
    first.start("t");
    await first.settled();
    // an operator-facing note written straight to the log, as the audit path does
    await first.log.append("message", first.snapshot().session, first.snapshot().branch, {
      role: "assistant",
      operatorFacing: true,
      content: `${AUDIT_MARK} CHANGES REQUIRED — add a test`,
    });
    await first.dispose();

    const second = mkAgent(ws, sessionDir, async () => reply("ok"));
    await second.init();
    second.enqueuePrompt("continue");
    second.start("t");
    await second.settled();
    assert.equal(
      (second.messages as ChatMessage[]).some((m) => String(m.content ?? "").includes(AUDIT_MARK)),
      false,
      "operator-facing audit notes must not enter the model's history (#50)",
    );
    await second.dispose();
  });
});

test("a provider 200 with zero choices is a retryable error, not a dead session (#50)", async () => {
  await useTempDirs(["a50g-", "a50h-"], async ([ws, sessionDir]) => {
    let calls = 0;
    const chatFn = async (): Promise<LlmResult> => {
      calls++;
      // first two attempts behave like the gateway's empty 200 (as thrown by
      // llm.ts), then the provider recovers
      if (calls <= 2) throw new Error("LLM API returned no choices");
      return reply("recovered");
    };
    const agent = new Agent({
      id: "t",
      workspace: ws,
      sessionDir,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn,
      autoContinue: false,
      // collapse the retry ladder's first waits so the test stays quick
      retryDelayMs: 1,
    } as any);
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    assert.ok(
      (agent.messages as ChatMessage[]).some((m) => String(m.content ?? "").includes("recovered")),
      "an empty-choices 200 must ride the retry ladder, not end the session (#50)",
    );
    await agent.dispose();
  });
});
/* ---------- contract: no restored shape may need a fabricated message ------ */

/**
 * The sweep behind both #50 fixes. Every `message` event shape a log can hold is
 * replayed through a REAL restore, and each is checked for the two things that
 * turn a resumed session into a 200 with zero choices:
 *
 *   1. no assistant turn the live run never had (blank, or operator-facing), and
 *   2. no dangling tool_call/tool_result pair.
 *
 * A blank turn that DID call tools is deliberately kept — sanitize() sends it
 * as "(tool call)", which is a valid placeholder — so it is exempt from (1) and
 * judged on (2) alone.
 */
test("no message-event shape survives a restore in an unsafe form (#50)", async () => {
  await useTempDirs(["a50o-ws-", "a50o-"], async ([workspace, base]) => {
    const cases: [string, Record<string, unknown>][] = [
      ["blank assistant, no calls", { role: "assistant", content: "" }],
      ["blank assistant, with calls", { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "bash" }] }],
      ["final summary", { role: "assistant", content: "done", final: true }],
      ["operator-facing audit", { role: "assistant", content: "audit verdict", operatorFacing: true }],
      ["normal assistant", { role: "assistant", content: "a real reply" }],
      ["user echo", { role: "user", content: "a real prompt" }],
    ];

    for (const [label, data] of cases) {
      const sessionDir = path.join(base, label.replace(/\W+/g, "-"));
      await mkdir(sessionDir, { recursive: true });
      const chatFn = async (): Promise<LlmResult> => reply("ok");
      const first = mkAgent(workspace, sessionDir, chatFn);
      await first.init();
      first.enqueuePrompt("go");
      first.start("t");
      await first.settled();
      await first.log.append("message", first.snapshot().session, first.snapshot().branch, data);
      if (label.includes("with calls"))
        await first.log.append("tool_result", first.snapshot().session, first.snapshot().branch, {
          callId: "c1",
          name: "bash",
          ok: true,
          result: "fine",
        });
      await first.dispose();

      const second = mkAgent(workspace, sessionDir, chatFn);
      await second.init();
      second.enqueuePrompt("next");
      second.start("t");
      await second.settled();

      const restored = second.messages as ChatMessage[];
      const a = audit(restored);
      assert.deepEqual(a.orphanCalls, [], `${label}: dangling tool_call (#50)`);
      assert.deepEqual(a.orphanResults, [], `${label}: dangling tool result (#50)`);
      // only the intentional blank+tool_calls case may keep a blank turn
      const blank = restored.filter((m) => m.role === "assistant" && m.content === "");
      if (label === "blank assistant, with calls")
        assert.equal(blank.length, 1, `${label}: must be KEPT — its results depend on it (#50)`);
      else
        assert.equal(blank.length, 0, `${label}: a blank assistant turn must not survive (#50)`);
      await second.dispose();
    }
  });
});

/**
 * The data-loss trap in the blank-turn fix.
 *
 * An operator can send a prompt with NO TEXT and only an image attachment. That
 * is a legitimate user turn whose content is empty and whose payload lives in
 * `content_parts` — the exact "blank message" shape the assistant-turn guard
 * drops. It must never be swept up by it: dropping it would silently delete the
 * operator's attachment from every future turn of that session.
 */
test("an image-only prompt survives a restore even though its text is empty (#50)", async () => {
  await useTempDirs(["a50p-", "a50q-"], async ([ws, sessionDir]) => {
    const chatFn = async (): Promise<LlmResult> => reply("ok");
    const first = mkAgent(ws, sessionDir, chatFn);
    await first.init();
    first.start("t");
    await first.settled();
    // text is "" and the image carries the whole message
    first.enqueuePrompt("", "user", [{ url: "data:image/png;base64,AAAA" }]);
    await first.settled();
    await first.dispose();

    const second = mkAgent(ws, sessionDir, chatFn);
    await second.init();
    second.enqueuePrompt("next");
    second.start("t");
    await second.settled();

    const restored = second.messages as ChatMessage[];
    const withImage = restored.filter((m) => (m.content_parts ?? []).length > 0);
    assert.ok(withImage.length > 0, "an image-only prompt must survive the restore (#50)");
    assert.ok(
      withImage.some((m) => m.role === "user"),
      "the operator's attachment must not be dropped as a blank message (#50)",
    );
    assert.ok(
      restored.some((m) => m.role === "user" && m.content === ""),
      "the blank-text user turn itself must be present (#50)",
    );
    await second.dispose();

    // The behavioural half above cannot fail on its own: prompts are replayed
    // from the "prompt" branch, which no message-branch guard touches. So pin
    // the guard's SCOPE directly — a blanket "drop every blank message" is the
    // exact edit that would start deleting user attachments, and it must fail
    // here rather than in production.
    const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
    assert.match(
      src,
      /if \(role === "assistant" && !content && !hasCalls\) continue;/,
      "the blank-turn drop must be scoped to ASSISTANT turns — a blanket drop deletes image-only prompts (#50)",
    );
  });
});
