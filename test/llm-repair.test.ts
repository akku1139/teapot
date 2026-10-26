import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
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

test("a restarted session does not replay the completion audit into the conversation (#50)", async () => {
  await useTempDirs(["a50a-", "a50b-"], async ([ws, sessionDir]) => {
    let turn = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      const _sys = String(messages[0]?.content ?? "");
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
      (first.conversation as ChatMessage[]).some((m) => String(m.content ?? "").includes(AUDIT_MARK)),
      false,
      "the live history must NOT carry the audit verdict (it was a side conversation)",
    );

    const second = mkAgent(ws, sessionDir, chatFn);
    await second.init();
    second.enqueuePrompt("anything else?");
    second.start("t");
    await second.settled();

    const leaked = (second.conversation as ChatMessage[]).filter((m) =>
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

test("a real tool call survives a restart and the resumed turn stays valid (#50)", async () => {
  await useTempDirs(["a50i-", "a50j-"], async ([ws, sessionDir]) => {
    const rejected: (string | null)[] = [];
    const sawResult: string[] = [];
    let resumed = 0;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      const last = String(messages.at(-1)?.content ?? "");
      if (!last.includes("independent completion AUDITOR")) rejected.push(providerReject(messages));
      if (last === "and now?") resumed++;
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
    assert.ok(
      (second.conversation as ChatMessage[]).some((m) => m.role === "tool"),
      "the tool result must survive the restart — otherwise the pair is broken (#50)",
    );
    await second.dispose();
  });
});

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

    const restored = second.conversation as ChatMessage[];
    assert.equal(
      restored.some((m) => m.role === "assistant" && m.content === ""),
      false,
      "an empty assistant turn must not survive the restore (#50)",
    );
    assert.equal(
      sent.some((m) => m.role === "assistant" && m.content === "(no content)"),
      false,
      `sanitize() would turn it into a sentence the agent never said (#50)`,
    );
    await second.dispose();
  });
});

test("an empty assistant turn that DID carry tool calls is kept (#50)", async () => {
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

    const restored = second.conversation as ChatMessage[];
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

test("an operator-facing message is skipped by the restore (#50)", async () => {
  await useTempDirs(["a50e-", "a50f-"], async ([ws, sessionDir]) => {
    const first = mkAgent(ws, sessionDir, async () => reply("ok"));
    await first.init();
    first.enqueuePrompt("hi");
    first.start("t");
    await first.settled();
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
      (second.conversation as ChatMessage[]).some((m) => String(m.content ?? "").includes(AUDIT_MARK)),
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
      retryDelayMs: 1,
    } as any);
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    assert.ok(
      (agent.conversation as ChatMessage[]).some((m) => String(m.content ?? "").includes("recovered")),
      "an empty-choices 200 must ride the retry ladder, not end the session (#50)",
    );
    await agent.dispose();
  });
});

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

      const restored = second.conversation as ChatMessage[];
      const a = audit(restored);
      assert.deepEqual(a.orphanCalls, [], `${label}: dangling tool_call (#50)`);
      assert.deepEqual(a.orphanResults, [], `${label}: dangling tool result (#50)`);
      const blank = restored.filter((m) => m.role === "assistant" && m.content === "");
      if (label === "blank assistant, with calls")
        assert.equal(blank.length, 1, `${label}: must be KEPT — its results depend on it (#50)`);
      else
        assert.equal(blank.length, 0, `${label}: a blank assistant turn must not survive (#50)`);
      await second.dispose();
    }
  });
});

