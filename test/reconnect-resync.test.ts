import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("runs POSIX commands through the bash tool");

test("ask_user parks only after answering the batch (#54)", async () => {
  const { mkdtempInRootSync } = await import("./helpers/tmp-root.ts");
  const { Agent } = await import("../src/agent/agent.ts");
  const { readEvents } = await import("../src/log/events.ts");
  const ws = mkdtempInRootSync("h54p-");
  const sd = mkdtempInRootSync("h54q-");
  let n = 0;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      if (n++ === 0) {
        return {
          message: {
            role: "assistant" as const,
            content: "",
            tool_calls: [
              { id: "p1", type: "function" as const, function: { name: "ask_user", arguments: JSON.stringify({ question: "which?" }) } },
              { id: "p2", type: "function" as const, function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } },
            ],
          },
        };
      }
      return { message: { role: "assistant" as const, content: "done" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  try {
    a.enqueuePrompt("go", "user");
    a.start("t");
    await a.settled().catch(() => {});
    const events = await readEvents(a.log.filePath);
    const calls = events.filter((e) => e.type === "tool_call").map((e) => String((e.data as { callId?: string }).callId));
    const results = new Set(events.filter((e) => e.type === "tool_result").map((e) => String((e.data as { callId?: string }).callId)));
    const assistant = a.conversationForTest.find((m) => (m.tool_calls?.length ?? 0) > 0);
    assert.equal(
      assistant?.tool_calls?.length,
      2,
      `the batch must have carried both calls for this check to mean anything; got ${JSON.stringify(assistant?.tool_calls?.map((c) => c.id))}`,
    );
    const answered = new Set(
      a.conversationForTest.filter((m) => m.role === "tool").map((m) => String(m.tool_call_id)),
    );
    const stranded = (assistant!.tool_calls ?? []).map((c) => c.id).filter((id) => !answered.has(id));
    assert.deepEqual(
      stranded,
      [],
      "every call in the batch must be answered before the loop parks, or the next provider request is rejected (#54)",
    );
    assert.ok(calls.includes("p1"), `the ask_user call must be logged; got ${JSON.stringify(calls)}`);
  } finally {
    await a.dispose().catch(() => {});
  }
});

test("stopping mid-batch leaves no unanswered tool_call (#54)", async () => {
  await useTempDirs(["h54a-", "h54b-"], async ([ws, sd]) => {
    let release: () => void = () => {};
    const _gate = new Promise<void>((r) => {
      release = r;
    });
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async () => ({
        message: {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            { id: "c1", type: "function" as const, function: { name: "bash", arguments: JSON.stringify({ command: "sleep 30" }) } },
            { id: "c2", type: "function" as const, function: { name: "read_file", arguments: JSON.stringify({ path: "x.txt" }) } },
          ],
        },
      }),
      autoContinue: false,
    } as any);
    await a.init();
    a.enqueuePrompt("go", "user");
    a.start("t");
    await new Promise((r) => setTimeout(r, 40));
    a.stop("stopped mid-batch");
    release();
    await a.settled();
    await new Promise((r) => setTimeout(r, 60));

    const { readEvents } = await import("../src/log/events.ts");
    const events = await readEvents(a.log.filePath);
    const calls = events.filter((e) => e.type === "tool_call").map((e) => String((e.data as any).callId));
    const results = new Set(events.filter((e) => e.type === "tool_result").map((e) => String((e.data as any).callId)));
    const orphans = calls.filter((id) => !results.has(id));
    assert.deepEqual(orphans, [], `every tool_call must be answered, or its row never completes (#54)`);
    await a.dispose();
  });
});
