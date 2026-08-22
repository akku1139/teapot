import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/agent.ts";
import type { ChatFn, ChatMessage, LlmConfig, LlmResult, ToolSpec } from "../src/agent/llm.ts";
import { readEvents } from "../src/log/events.ts";

const LLM: LlmConfig = { baseUrl: "http://mock", apiKey: "mock", model: "mock-model" };

/* ---------- mock LLM ---------- */

interface Req {
  messages: ChatMessage[];
  tools: ToolSpec[];
  n: number;
}

function mkMock(handler: (req: Req) => Promise<LlmResult> | LlmResult): {
  chat: ChatFn;
  calls: Req[];
} {
  const calls: Req[] = [];
  return {
    calls,
    chat: async (_cfg, messages, tools, signal) => {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const req: Req = { messages, tools, n: calls.length };
      calls.push(req);
      return handler(req);
    },
  };
}

const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

const reply = (content: string, toolCalls?: ReturnType<typeof tc>[]): LlmResult => ({
  message: {
    role: "assistant",
    content,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  },
});

async function mkAgent(more: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  const ws = await mkdtemp(path.join(tmpdir(), "teapot-agent-ws-"));
  const data = await mkdtemp(path.join(tmpdir(), "teapot-agent-data-"));
  const agent = new Agent({
    id: "t",
    workspace: ws,
    llm: LLM,
    logFile: path.join(data, "t.jsonl"),
    continueDelayMs: 10,
    ...more,
  });
  await agent.init();
  return { agent, ws, data };
}

/* ---------- basic round / finish ---------- */

test("agent: plain answer ends round; finish marks goal done", async () => {
  const mock = mkMock((req): LlmResult => {
    if (req.n === 0)
      return reply("working", [tc("c1", "report_progress", { doing: "x", goalStatus: "ok", recent: "y" })]);
    if (req.n === 1) return reply("all finished!", [tc("c2", "finish", { goalComplete: true, summary: "did it" })]);
    throw new Error("too many llm calls");
  });
  const { agent } = await mkAgent({ chatFn: mock.chat });
  await agent.setGoal("achieve something");
  agent.enqueuePrompt("go");
  agent.start("test");
  await agent.settled();

  assert.equal(agent.status, "idle");
  assert.equal(agent.goal.status, "done");
  assert.equal(agent.stats.turns, 2);
  // finish must leave an answered tool_call in history (API-valid sequence)
  const last = agent.messages.at(-1)!;
  assert.equal(last.role, "tool");
  assert.equal(last.tool_call_id, "c2");
  await agent.dispose();
});

/* ---------- stop aborts in-flight call ---------- */

test("stop() interrupts a hanging LLM call immediately", async () => {
  const { agent } = await mkAgent({
    chatFn: (_cfg, _m, _t, signal) =>
      new Promise<LlmResult>((_, rej) => {
        signal?.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
  });
  agent.enqueuePrompt("hello");
  agent.start("test");
  await new Promise((r) => setTimeout(r, 50)); // let the loop reach the hanging call
  const t0 = Date.now();
  agent.stop("user");
  await agent.settled();
  assert.equal(agent.status, "stopped");
  assert.ok(Date.now() - t0 < 900, `stop took too long: ${Date.now() - t0}ms`);
  // stopping is control flow — no error events should be logged
  const events = await readEvents(agent.log.filePath);
  assert.ok(!events.some((e) => e.type === "error"), "stop must not log error events");
  await agent.dispose();
});

/* ---------- context compaction ---------- */

test("compaction summarizes old turns when the budget is exceeded", async () => {
  const big = "x".repeat(1000);
  const mock = mkMock((req): LlmResult => {
    const sys = String(req.messages[0]?.content ?? "");
    if (sys.includes("compress")) return reply("- made big.txt with filler\n- next: verify");
    if (req.n === 0)
      return reply("creating file", [tc("w1", "write_file", { path: "big.txt", content: big })]);
    return reply("verified, done");
  });
  const { agent } = await mkAgent({ chatFn: mock.chat, contextTokenBudget: 200, autoContinue: false });
  agent.enqueuePrompt("make the file");
  agent.start("test");
  await agent.settled();

  assert.equal(agent.status, "idle");
  assert.equal(agent.stats.compactions, 1);
  const note = agent.messages[0]!;
  assert.equal(note.role, "user");
  assert.match(note.content ?? "", /Context was compacted/);
  assert.match(note.content ?? "", /made big\.txt/);
  // kept tail still starts at a valid boundary and contains the exchange
  assert.equal(agent.messages[1]!.role, "assistant");
  const events = await readEvents(agent.log.filePath);
  const noteEv = events.find((e) => e.type === "system_note")!;
  assert.ok(noteEv);
  assert.equal((noteEv.data as Record<string, unknown>).event, "context-compacted");
  await agent.dispose();
});

/* ---------- session restore from JSONL ---------- */

test("restart rebuilds conversation (incl. tool args/results) from the log", async () => {
  const first = mkMock((req): LlmResult =>
    req.n === 0
      ? reply("on it", [tc("a1", "write_file", { path: "hello.txt", content: "hi there" })])
      : reply("created hello.txt"),
  );
  const a = await mkAgent({ chatFn: first.chat, autoContinue: false });
  a.agent.enqueuePrompt("create hello.txt");
  a.agent.start("test");
  await a.agent.settled();
  await a.agent.dispose();

  const second = mkMock(() => reply("resumed ok", [tc("f1", "finish", { goalComplete: true })]));
  const b = new Agent({
    id: "t",
    workspace: a.ws,
    llm: LLM,
    logFile: path.join(a.data, "t.jsonl"),
    continueDelayMs: 10,
    chatFn: second.chat,
  });
  await b.init();

  const msgs = b.messages;
  assert.equal(msgs.length, 4); // prompt, assistant+call, tool result, final assistant
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "tool", "assistant"],
  );
  // tool arguments were recovered from the logged tool_call event
  assert.match(msgs[1]!.tool_calls![0].function.arguments, /hello\.txt/);
  assert.match(msgs[2]!.content ?? "", /wrote/);

  // restored agent can keep working without breaking the sequence
  b.enqueuePrompt("wrap up please");
  b.start("resume");
  await b.settled();
  assert.equal(b.status, "idle");
  assert.equal(b.goal.status, "done");
  await b.dispose();
});

/* ---------- runaway guard ---------- */

test("consecutive tool failures trip the runaway guard", async () => {
  let n = 0;
  const { agent } = await mkAgent({
    maxConsecutiveToolErrors: 2,
    chatFn: () => reply("try", [tc(`bad${n++}`, "read_file", { path: "missing.txt" })]),
  });
  agent.enqueuePrompt("go");
  agent.start("test");
  await agent.settled();
  assert.equal(agent.status, "error");
  assert.match(agent.statusReason, /consecutive tool failures/);
  await agent.dispose();
});

/* ---------- skills integration ---------- */

test("agent saves then loads its own skill via tools", async () => {
  const body = "# Coffee protocol\n1. grind\n2. bloom\n3. pour";
  const mock = mkMock((req): LlmResult => {
    if (req.n === 0)
      return reply("saving skill", [
        tc("s1", "save_skill", {
          name: "coffee-brewing",
          description: "how to brew coffee properly",
          content: body,
        }),
      ]);
    if (req.n === 1) {
      // system prompt of this turn must already list the fresh skill
      const sys = String(req.messages[0]?.content ?? "");
      assert.match(sys, /coffee-brewing/);
      return reply("loading my skill", [tc("s2", "load_skill", { name: "coffee-brewing" })]);
    }
    if (req.n === 2) {
      const toolMsg = [...req.messages].reverse().find((m) => m.role === "tool")!;
      assert.match(toolMsg.content ?? "", /grind/);
      return reply("skill loaded, finishing");
    }
    return reply("done", [tc("f9", "finish", { goalComplete: true })]);
  });

  const { agent, ws } = await mkAgent({ chatFn: mock.chat });
  agent.enqueuePrompt("document your coffee knowledge as a skill");
  agent.start("test");
  await agent.settled();

  assert.equal(agent.status, "idle");
  const written = await readFile(path.join(ws, "skills", "coffee-brewing", "SKILL.md"), "utf8");
  assert.match(written, /name: coffee-brewing/);
  assert.match(written, /grind/);
  await agent.dispose();
});
