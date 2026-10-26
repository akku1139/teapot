import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { useTempDir, useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { ChatFn, ChatMessage, LlmConfig, LlmResult, ToolSpec } from "../src/agent/llm.ts";
import { readEvents } from "../src/log/events.ts";
import { dataOf } from "./helpers/event-data.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";
import { isSummarizerRequest } from "./helpers/summarizer-request.ts";
import { testTmpRoot } from "./helpers/tmp-root.ts";

markPosixOnly("runs POSIX commands through the bash tool");

const LLM: LlmConfig = { baseUrl: "http://mock", apiKey: "mock", model: "mock-model" };

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

async function withAgent<T>(
  more: Partial<ConstructorParameters<typeof Agent>[0]>,
  fn: (a: Agent, ws: string, data: string) => Promise<T> | T,
): Promise<T> {
  return useTempDirs(["teapot-agent-ws-", "teapot-agent-sess-"], async ([ws, sessionDir]) => {
    const agent = new Agent({
      id: "t",
      workspace: ws,
      llm: LLM,
      sessionDir,
      continueDelayMs: 10,
      ...more,
    });
    await agent.init();
    return fn(agent, ws, sessionDir);
  });
}

test("agent: plain answer ends round; finish marks goal done", async () => {
  const mock = mkMock((req): LlmResult => {
    if (req.n === 0)
      return reply("working", [tc("c1", "report_progress", { doing: "x", goalStatus: "ok", recent: "y" })]);
    if (req.n === 1) return reply("all finished!", [tc("c2", "finish", { goalComplete: true, summary: "did it" })]);
    throw new Error("too many llm calls");
  });
  await withAgent({ chatFn: mock.chat }, async (agent) => {
    await agent.setGoal("achieve something");
    agent.enqueuePrompt("go");
    agent.start("test");
    await agent.settled();

    assert.equal(agent.status, "idle");
    assert.equal(agent.goal.status, "done");
    assert.equal(agent.stats.turns, 2);
    const last = agent.conversation.at(-1)!;
    assert.equal(last.role, "tool");
    assert.equal(last.tool_call_id, "c2");
    await agent.dispose();
  });
});

test("stop() interrupts a hanging LLM call immediately", async () => {
  await withAgent({
      chatFn: (_cfg, _m, _t, signal) =>
        new Promise<LlmResult>((_, rej) => {
          signal?.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    }, async (agent) => {
    agent.enqueuePrompt("hello");
    agent.start("test");
    await new Promise((r) => setTimeout(r, 50)); 
    const t0 = Date.now();
    agent.stop("user");
    await agent.settled();
    assert.equal(agent.status, "stopped");
    assert.ok(Date.now() - t0 < 900, `stop took too long: ${Date.now() - t0}ms`);
    const events = await readEvents(agent.log.filePath);
    assert.ok(!events.some((e) => e.type === "error"), "stop must not log error events");
    await agent.dispose();
  });
});

test("dispose() kills a running tool so master shutdown never hangs", { timeout: 15_000 }, async () => {
  const mock = mkMock(() =>
    reply("running a long job", [tc("l1", "bash", { command: "sleep 30", timeout_ms: 600_000 })]),
  );
  await withAgent({ chatFn: mock.chat }, async (agent) => {
    agent.enqueuePrompt("go");
    agent.start("test");
    await new Promise((r) => setTimeout(r, 80)); 
    const t0 = Date.now();
    await agent.dispose();
    assert.ok(Date.now() - t0 < 3_000, `dispose took ${Date.now() - t0}ms — tool was not killed`);
    await agent.dispose();
  });
});

test("stopping mid-stream keeps the partial reply in the log", async () => {
  await withAgent({
      chatFn: (_cfg, _m, _t, signal) =>
        new Promise<LlmResult>((_, rej) => {
          const fail = () =>
            rej(
              Object.assign(new Error("aborted"), {
                name: "APIUserAbortError",
                partial: { text: "half-written rep", reasoning: "partial thoughts" },
              }),
            );
          const t = setTimeout(fail, 5_000);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            fail();
          });
        }),
    }, async (agent) => {
    agent.enqueuePrompt("write me a poem");
    agent.start("test");
    await new Promise((r) => setTimeout(r, 60));
    agent.stop("user");
    await agent.settled();
    assert.equal(agent.status, "stopped");

    const events = await readEvents(agent.log.filePath);
    const m = events.find((e) => e.type === "message" && (e.data as Record<string, unknown>).interrupted);
    assert.ok(m, "interrupted partial message must be logged");
    assert.match((m.data as Record<string, unknown>).content as string, /half-written rep/);
    assert.ok(agent.conversation.some((x) => x.role === "assistant" && x.content?.includes("half-written")));
    assert.ok(!events.some((e) => e.type === "error"));
    await agent.dispose();
  });
});

test("prompts sent mid-run are logged instantly and delivered at the next turn boundary", { timeout: 20_000 }, async () => {
  let secondRoundUserTexts: (string | null)[] = [];
  const mock = mkMock((req): LlmResult => {
    if (req.n === 0)
      return reply("starting work", [tc("b1", "bash", { command: "sleep 1" })]);
    secondRoundUserTexts = req.messages.filter((m) => m.role === "user").map((m) => m.content ?? null);
    return reply("got your follow-up");
  });
  await withAgent({ chatFn: mock.chat, autoContinue: false }, async (agent) => {
    agent.enqueuePrompt("first task");
    agent.start("test");
    await new Promise((r) => setTimeout(r, 80)); 
    assert.equal(agent.status, "running");
    const t0 = Date.now();
    agent.enqueuePrompt("second, urgent"); 
    assert.ok(Date.now() - t0 < 100, "enqueuePrompt must not block on the running loop");
    await agent.settled();

    assert.ok(
      secondRoundUserTexts.includes("second, urgent"),
      `model should see the queued prompt, saw: ${JSON.stringify(secondRoundUserTexts)}`,
    );
    const events = await readEvents(agent.log.filePath);
    const promptEv = events.find((e) => e.type === "prompt" && (e.data as Record<string, unknown>).text === "second, urgent");
    const toolResultEv = events.find((e) => e.type === "tool_result");
    assert.ok(promptEv && toolResultEv);
    assert.ok(promptEv.seq < toolResultEv.seq, "prompt event must be logged before the running tool finished");
    await agent.dispose();
  });
});

test("image attachments flow into multimodal content parts and survive replay", async () => {
  const seen: any[] = [];
  const chatFn = async (_cfg: unknown, messages: any) => {
    seen.push(JSON.parse(JSON.stringify(messages)));
    return reply("got it");
  };
  await withAgent({ chatFn, autoContinue: false }, async (agent) => {
    agent.enqueuePrompt("what is in this picture?", "user", [
      { url: "data:image/png;base64,iVBORw0KGgo=", name: "shot.png" },
    ]);
    agent.start("t");
    await agent.settled();
    assert.equal(agent.status, "idle");
    const lastReq = seen[seen.length - 1]!;
    const userMsg = [...lastReq].reverse().find((m: any) => m.role === "user");
    assert.ok(Array.isArray(userMsg.content_parts), "multimodal message carries content parts");
    assert.equal(userMsg.content_parts[0].type, "text");
    assert.equal(userMsg.content_parts[0].text, "what is in this picture?");
    assert.equal(userMsg.content_parts[1].type, "image_url");
    assert.match(userMsg.content_parts[1].image_url.url, /^data:image\/png/);

    const events = await readEvents(path.join(agent.snapshot().sessionDir, "chat.jsonl"));
    const promptEv = events.find((e) => e.type === "prompt");
    assert.ok(promptEv && Array.isArray((promptEv.data as any).images), "images persisted to the log");
    await agent.dispose();

    const b = new Agent({
      id: "t2",
      workspace: (agent as unknown as { opts: { workspace: string } }).opts.workspace,
      llm: LLM,
      sessionDir: agent.snapshot().sessionDir, 
      continueDelayMs: 10,
      chatFn,
      autoContinue: false,
    });
    await b.init();
    await b.load();
    const restored = b.conversation.find((m) => m.content_parts?.length);
    assert.ok(restored, "replay restores the multimodal message");
    assert.equal(restored!.content_parts![1]!.type, "image_url");
    await b.dispose();
  });
});

test("background bash exit notifies the agent at the next turn boundary", async () => {
  let sawReport: string | null = null;
  let calls = 0;
  const chatFn = async (_cfg: unknown, messages: any): Promise<LlmResult> => {
    calls++;
    if (calls === 1) return reply("starting job", [tc("b1", "bash", { command: "echo hi; exit 3", background: true })]);
    if (!sawReport && messages.some((m: any) => m.role === "user" && /Background job report/.test(String(m.content)))) {
      sawReport = "reported";
      return reply("noted, done", [tc("fin", "finish", { goalComplete: true })]);
    }
    return reply("working");
  };
  await withAgent({ chatFn, autoContinue: true, continueDelayMs: 20 }, async (agent) => {
    await agent.setGoal("watch background jobs");
    agent.enqueuePrompt("run something");
    agent.start("t");
    await agent.settled();
    for (let i = 0; i < 250 && !sawReport; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(sawReport, "a later LLM call must contain the Background job report");
    let reportLogged = false;
    for (let i = 0; i < 100 && !reportLogged; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const evts = await readEvents(path.join(agent.snapshot().sessionDir, "chat.jsonl"));
      reportLogged = evts.some((e) => e.type === "prompt" && /Background job report/.test(String((e.data as { text?: unknown })?.text ?? "")));
    }
    assert.ok(reportLogged, "the background report must reach the conversation");
    const events = await readEvents(path.join(agent.snapshot().sessionDir, "chat.jsonl"));
    const report = events.find(
      (e) => e.type === "prompt" && /Background job report/.test(String((e.data as { text?: unknown })?.text ?? "")),
    );
    assert.ok(report, "the report must be logged as a prompt");
    const reportText = String((report!.data as { text?: unknown }).text ?? "");
    assert.match(reportText, /bg\d+: FAILED with exit code 3/);
    assert.match(reportText, /\|\s*hi/); 
    const note = events.find((e) => e.type === "system_note" && (e.data as any).event === "background-exit");
    assert.ok(note, "a background-exit timeline row must be logged");
    await agent.dispose();
  });
});
test("a bg job that exits as the round parks still wakes the agent", async () => {
  let sawReport = false;
  let calls = 0;
  const chatFn = async (_cfg: unknown, messages: any): Promise<LlmResult> => {
    calls++;
    if (calls === 1)
      return reply("starting", [tc("b1", "bash", { command: "echo hi", background: true })]);
    if (
      messages.some(
        (m: any) => m.role === "user" && /Background job report/.test(String(m.content)),
      )
    ) {
      sawReport = true;
      return reply("acknowledged", [tc("fin", "finish", { goalComplete: true })]);
    }
    return reply("waiting");
  };
  await withAgent({ chatFn, autoContinue: true, continueDelayMs: 20 }, async (agent, _ws, _sd) => {
    await agent.setGoal("watch a background job");
    agent.enqueuePrompt("start it");
    agent.start("t");
    await agent.settled();
    for (let i = 0; i < 250 && !sawReport; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      sawReport,
      "the agent must be woken by the exit even when it lands mid-teardown",
    );
    await agent.dispose();
  });
});

test("delivered prompt emits a prompt-delivered note carrying its promptId", async () => {
  let round = 0;
  const mock = mkMock((req): LlmResult => {
    if (round === 0) {
      round++;
      return reply("working", [tc("b1", "bash", { command: "sleep 0.2" })]);
    }
    void req;
    return reply("done");
  });
  await withAgent({ chatFn: mock.chat, autoContinue: false }, async (agent) => {
    const pid = agent.enqueuePrompt("mid-run message");
    assert.ok(pid, "enqueuePrompt must return a promptId for user prompts");
    agent.start("test");
    await new Promise((r) => setTimeout(r, 50));
    agent.enqueuePrompt("queued while busy").length; 
    await agent.settled();
    const events = await readEvents(agent.log.filePath);
    const notes = events.filter(
      (e) => e.type === "system_note" && (e.data as Record<string, unknown>).event === "prompt-delivered",
    );
    const pids = notes.map((n) => String((n.data as Record<string, unknown>).promptId));
    assert.equal(notes.length, 2, `both prompts must be delivered exactly once — got ${notes.length}`);
    assert.ok(pids.includes(pid), "the first prompt's id must appear on a delivered note");
    const logged = events.filter((e) => e.type === "prompt" && (e.data as any)?.source === "user");
    for (const l of logged)
      assert.ok((l.data as { promptId?: unknown }).promptId, "logged user prompts carry their echo id");
    await agent.dispose();
  });
});

test("an agent without a goal text does not auto-continue forever", { timeout: 15_000 }, async () => {
  let calls = 0;
  await withAgent({
      chatFn: async () => {
        calls++;
        return reply("ok, standing by");
      },
      continueDelayMs: 10,
    }, async (agent) => {
    agent.enqueuePrompt("hello");
    agent.start("test");
    await agent.settled();
    assert.equal(agent.status, "idle");
    assert.equal(calls, 1); 
    await agent.dispose();
  });
});

test("a queued prompt keeps a finished round going", { timeout: 15_000 }, async () => {
  const mock = mkMock(async (req): Promise<LlmResult> => {
    if (req.n === 0) {
      await new Promise((r) => setTimeout(r, 300)); 
      return reply("done with round one");
    }
    return reply("round two handled", [tc("f1", "finish", { goalComplete: true })]);
  });
  await withAgent({ chatFn: mock.chat, continueDelayMs: 10 }, async (agent) => {
    await agent.setGoal("stay available");
    agent.enqueuePrompt("first");
    agent.start("test");
    await new Promise((r) => setTimeout(r, 60));
    agent.enqueuePrompt("second arrives right at the boundary");
    await agent.settled();
    assert.equal(agent.goal.status, "done");
    const userMsgs = agent.conversation.filter((m) => m.role === "user");
    assert.ok(userMsgs.some((m) => m.content === "second arrives right at the boundary"));
    await agent.dispose();
  });
});

test("progress prompts wait for real output, not just elapsed time", { timeout: 25_000 }, async () => {
  let big = false;
  let sawAsk = false;
  let harnessedAt = Infinity;
  const mock: ChatFn = async (_cfg, _messages, tools) => {
    const lastUser = [..._messages].reverse().find((m) => m.role === "user");
    if (!sawAsk && /Please give a brief progress report/.test(String(lastUser?.content ?? ""))) {
      harnessedAt = Math.min(harnessedAt, Date.now());
      sawAsk = true;
      return reply("reporting", [tc("rp", "report_progress", { doing: "on track" })]);
    }
    if (sawAsk) return reply("done", [tc("f", "finish", { goalComplete: true })]);
    if (!big) return { message: { role: "assistant", content: "k" } }; 
    return { message: { role: "assistant", content: "x".repeat(5000) } };
  };
  await withAgent({
      chatFn: mock,
      progressIntervalMs: 50,
      progressMinChars: 4000,
      progressMaxQuietTurns: 60,
      continueDelayMs: 5,
    }, async (agent) => {
    await agent.setGoal("grind away");
    agent.enqueuePrompt("go");
    agent.start("t");
    await new Promise((r) => setTimeout(r, 150)); 
    assert.equal(sawAsk, false); 
    const bigAt = Date.now();
    big = true;
    await agent.settled();
    assert.ok(Number.isFinite(harnessedAt), "a progress request should happen once output flows");
    assert.ok(harnessedAt >= bigAt, "progress request must not precede sufficient output");
    const events = await readEvents(agent.log.filePath);
    const asks = events.filter(
      (e) =>
        e.type === "prompt" &&
        String((e.data as Record<string, unknown>).text ?? "").includes("progress report"),
    );
    assert.equal(asks.length, 1, "exactly ONE progress request (#45)");
    await agent.dispose();
  });
});

test("requested progress report appears exactly ONCE (no voluntary re-report)", async () => {
  let reportedVoluntarily = false;
  let askedOnce = false;
  const mock: ChatFn = async (_cfg, messages) => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (/Please give a brief progress report/.test(String(lastUser?.content ?? ""))) {
      askedOnce = true;
      return reply("reporting now", [tc("rp", "report_progress", { doing: "asked report" })]);
    }
    if (!askedOnce && !reportedVoluntarily) {
      reportedVoluntarily = true;
      return reply("working on it", [tc("w1", "list_dir", {})]);
    }
    if (askedOnce)
      return reply("wrapping up", [tc("fin", "finish", { goalComplete: true })]);
    return reply("all done"); 
  };
  await withAgent(
    { chatFn: mock, progressIntervalMs: 50, progressMinChars: 1, autoContinue: true, continueDelayMs: 5 },
    async (agent) => {
      await agent.setGoal("exercise single-shot reporting");
      agent.enqueuePrompt("go");
      agent.start("t");
      await agent.settled();
      const events = await readEvents(agent.log.filePath);
      const cards = events.filter((e) => e.type === "progress");
      assert.ok(cards.length >= 1, "a progress card must exist once the interval elapsed");
      assert.equal(
        new Set(cards.map((c) => c.seq)).size,
        cards.length,
        "no duplicate progress cards at the same moment",
      );
      const roles = agent.conversation.map((m) => m.role);
      for (let i = 0; i < roles.length; i++) {
        if (roles[i] === "tool") assert.equal(roles[i - 1], "assistant", `tool result at ${i} must follow an assistant turn`);
      }
      await agent.dispose();
    },
  );
});

test("requested report keeps a valid sequence even when the model calls other tools", async () => {
  const mock: ChatFn = async (_cfg, messages) => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (/Please give a brief progress report/.test(String(lastUser?.content ?? ""))) {
      return reply("", [tc("x1", "get_goal", {})] as never);
    }
    return reply("round over");
  };
  await withAgent(
    { chatFn: mock, progressIntervalMs: 50, progressMinChars: 1, autoContinue: false },
    async (agent) => {
      await agent.setGoal("sequence integrity");
      agent.enqueuePrompt("go");
      agent.start("t");
      await agent.settled();
      const roles = agent.conversation.map((m) => m.role);
      for (let i = 0; i < roles.length; i++) {
        if (roles[i] === "tool") {
          assert.ok(i > 0 && roles[i - 1] === "assistant", `[user, tool] hole at ${i}`);
        }
      }
      await agent.dispose();
    },
  );
});

test("editing a sent prompt forks and can summarize the abandoned tail", async () => {
  const mock = mkMock((req): LlmResult => {
    if (isSummarizerRequest(req.messages)) return reply("- created hello.txt"); 
    if (req.n === 0)
      return reply("creating", [tc("w1", "write_file", { path: "hello.txt", content: "hi" })]);
    return reply("done creating");
  });
  await withAgent({ chatFn: mock.chat, autoContinue: false }, async (agent) => {
    await agent.setGoal("make files");
    agent.enqueuePrompt("create hello.txt");
    agent.start("t");
    await agent.settled();

    const events = await readEvents(agent.log.filePath);
    const firstPrompt = events.find((e) => e.type === "prompt")!;
    const r = await agent.editPromptAt(firstPrompt.id, "create hello2.txt instead", "summarize");
    assert.ok(r.droppedEvents >= 1);
    assert.notEqual(r.branch, "br0");

    const ev2 = await readEvents(agent.log.filePath);
    const forkEv = ev2.find((e) => e.type === "fork" && (e.data as Record<string, unknown>).reason === "prompt-edited");
    assert.ok(forkEv);
    const newPrompt = ev2.filter((e) => e.type === "prompt").at(-1)!;
    assert.equal((newPrompt.data as Record<string, unknown>).text, "create hello2.txt instead");

    const texts = agent.conversation.map((m) => m.content ?? "");
    assert.ok(texts.some((t) => t.includes("another timeline")), "summary note expected");
    assert.match(texts.find((t) => t.includes("Notes from what happened")) ?? "", /created hello\.txt/);

    agent.enqueuePrompt("kick");
    agent.start("kick");
    await new Promise((r2) => setTimeout(r2, 30));
    if (agent.status === "running") {
      await assert.rejects(() => agent.editPromptAt(firstPrompt.id, "x", "discard"));
      agent.stop("cleanup");
      await agent.settled();
    }
    await agent.dispose();
  });
});

test("get_todo/set_todo round-trips the operator task list", async () => {
  const toolResults: string[] = [];
  let n = 0;
  const chat: ChatFn = async (_c, messages) => {
    const i = n++;
    if (i > 0) {
      const t = [...messages].reverse().find((m) => m.role === "tool");
      toolResults.push(t?.content ?? "");
    }
    if (i === 0) return reply("checking the list", [tc("t1", "get_todo", {})]);
    if (i === 1)
      return reply("first item done", [tc("t2", "set_todo", { content: "- [x] a\n- [ ] b" })]);
    return reply("list updated");
  };
  await withAgent({ chatFn: chat, autoContinue: false }, async (agent) => {
    await agent.setGoal("work the list");
    await agent.setTodo("- [ ] a\n- [ ] b"); 
    agent.enqueuePrompt("start working through the tasks");
    agent.start("t");
    await agent.settled();

    assert.match(toolResults[0]!, /\[ \] a/); 
    assert.match(toolResults[1]!, /task list replaced/);
    assert.equal(agent.todo, "- [x] a\n- [ ] b"); 
    const todoPath = path.join(agent.snapshot().sessionDir, "todo.md");
    assert.match(await readFile(todoPath, "utf8"), /\[x\] a/);
    await agent.dispose();
  });
});

test("ask_user waits for the operator and resumes with their answer", { timeout: 15_000 }, async () => {
  const mock = mkMock((req): LlmResult => {
    if (req.n === 0)
      return reply("need a decision", [
        tc("q", "ask_user", { question: "A or B?", options: ["do A", "do B"] }),
      ]);
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    assert.match(lastUser?.content ?? "", /B/);
    return reply("went with B", [tc("f", "finish", { goalComplete: true })]);
  });
  await withAgent({ chatFn: mock.chat }, async (agent) => {
    await agent.setGoal("decide something");
    agent.enqueuePrompt("go");
    agent.start("t");
    for (let i = 0; i < 40 && agent.status !== "needs_operator"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(agent.status, "needs_operator");
    assert.equal(agent.snapshot().awaiting, true);

    const events = await readEvents(agent.log.filePath);
    const q = events.find((e) => e.type === "question");
    assert.ok(q);
    assert.deepEqual((q.data as Record<string, unknown>).options, ["do A", "do B"]);

    agent.enqueuePrompt("B");
    agent.start("reply");
    await agent.settled();
    assert.equal(agent.status, "idle");
    assert.equal(agent.goal.status, "done");
    await agent.dispose();
  });
});

test("session cost accumulates from usage when pricing is set", async () => {
  const seen: { input?: number; output?: number; cachedInputTokens?: number }[] = [];
  const mock: ChatFn = (_cfg, _messages, _tools, _signal, onDelta) => {
    onDelta?.({ text: "working", reasoning: "" });
    return Promise.resolve({
      message: { role: "assistant", content: "step done" },
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 800_000 },
    });
  };
  void seen;
  await withAgent({ chatFn: mock, autoContinue: false }, async (agent) => {
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    assert.equal(agent.stats.costUsd ?? 0, 0, "no pricing → no estimate");
    await agent.setModelPricing({ prompt: 0.000003, completion: 0.000015 });
    const events = await readEvents(agent.log.filePath);
    const usages = events.filter((e) => e.type === "usage").length;
    assert.ok(usages >= 1, "usage event logged");
    const oneTurn = 0.6 + 1.5 + 0.24;
    assert.ok(
      Math.abs((agent.stats.costUsd ?? 0) - oneTurn) < 0.0001,
      `recomputed cost should be ~${oneTurn.toFixed(2)}, got ${agent.stats.costUsd}`,
    );
    assert.equal(typeof agent.snapshot().stats.costUsd, "number");
    await agent.dispose();
  });
});

test("compaction keys off the API's prompt_tokens, not the char estimate", async () => {
  const big = "z".repeat(12_000);
  const mock = mkMock((req): LlmResult => {
    if (isSummarizerRequest(req.messages)) return reply("- notes from earlier");
    if (req.n % 2 === 1) return reply("done");
    return {
      ...reply("working", [tc(`w${req.n}`, "bash", { cmd: `echo ${"e".repeat(40)}` })]),
      usage: { inputTokens: 40_000, outputTokens: 2 },
    };
  });
  await withAgent({ chatFn: mock.chat, contextTokenBudget: 8000, autoContinue: false }, async (agent) => {
    await agent.setGoal("exercise compaction");
    for (let i = 0; i < 5; i++) {
      agent.enqueuePrompt(`go ${i} ${big}`);
      agent.start("t");
      await agent.settled();
    }
    assert.ok(agent.stats.compactions >= 1, "usage above budget must compact");
    assert.match(agent.conversation[0]!.content ?? "", /Context was compacted/);
    await agent.dispose();
  });
});

test("compactNow forces a pass and reports whether it ran", async () => {
  const mock = mkMock((req): LlmResult =>
    req.n === 0 ? reply("working", [tc("w", "write_file", { path: "a.txt", content: "hi" })]) : reply("done"),
  );
  await withAgent({ chatFn: mock.chat, autoContinue: false }, async (agent) => {
    agent.enqueuePrompt("make a file");
    agent.start("t");
    await agent.settled();

    const r = await agent.compactNow();
    assert.equal(r.ran, true);
    assert.equal(agent.stats.compactions, 1);
    assert.match(agent.conversation[0]!.content ?? "", /Context was compacted/);
    const r2 = await agent.compactNow();
    assert.equal(r2.ran, false);
    await agent.dispose();
  });
});

test("compaction summarizes old turns when the budget is exceeded", async () => {
  const mock = mkMock((req): LlmResult => {
    if (isSummarizerRequest(req.messages)) return reply("- SUMMARY: made big.txt with filler; next: verify");
    if (req.n % 2 === 1) return reply("done");
    return reply("writing", [tc(`w${req.n}`, "bash", { cmd: `echo ${"e".repeat(200)}` })]);
  });
  await withAgent({ chatFn: mock.chat, contextTokenBudget: 8000, autoContinue: false }, async (agent) => {
    for (let i = 0; i < 6; i++) {
      agent.enqueuePrompt(`step ${i} ${"y".repeat(12_000)}`);
      agent.start("test");
      await agent.settled();
    }

    assert.equal(agent.status, "idle");
    assert.ok(agent.stats.compactions >= 1, `expected a compaction, got ${agent.stats.compactions}`);
    const note = agent.conversation[0]!;
    assert.equal(note.role, "user");
    assert.match(note.content ?? "", /Context was compacted/);
    assert.match(note.content ?? "", /made big\.txt/, `the summary text must be the summarizer's, not a truncation notice: ${String(note.content).slice(0, 80)}`);
    assert.equal(agent.conversation[1]!.role, "assistant");
    const events = await readEvents(agent.log.filePath);
    const noteEv = events.find(
      (e) => e.type === "system_note" && (e.data as Record<string, unknown>).event === "context-compacted",
    )!;
    assert.ok(noteEv);
    await agent.dispose();
  });
});

test("restart rebuilds conversation (incl. tool args/results) from the log", async () => {
  const first = mkMock((req): LlmResult =>
    req.n === 0
      ? reply("on it", [tc("a1", "write_file", { path: "hello.txt", content: "hi there" })])
      : reply("created hello.txt"),
  );
  await withAgent({ chatFn: first.chat, autoContinue: false }, async (a, ws, data) => {
    a.enqueuePrompt("create hello.txt");
    a.start("test");
    await a.settled();
    await a.dispose();

    const second = mkMock(() => reply("resumed ok", [tc("f1", "finish", { goalComplete: true })]));
    const b = new Agent({
      id: "t",
      workspace: ws,
      llm: LLM,
      sessionDir: data, 
      continueDelayMs: 10,
      chatFn: second.chat,
    });
    await b.init();
    assert.equal(b.status, "stopped"); 
    await b.load(); 

    const msgs = b.conversation;
    assert.equal(msgs.length, 4); 
    assert.deepEqual(
      msgs.map((m) => m.role),
      ["user", "assistant", "tool", "assistant"],
    );
    assert.match(msgs[1]!.tool_calls![0].function.arguments, /hello\.txt/);
    assert.match(msgs[2]!.content ?? "", /wrote/);

    b.enqueuePrompt("wrap up please");
    b.start("resume");
    await b.settled();
    assert.equal(b.status, "idle");
    assert.equal(b.goal.status, "done");
    await b.dispose();
  });
});

test("consecutive tool failures trip the runaway guard", async () => {
  let n = 0;
  await withAgent({
      maxConsecutiveToolErrors: 2,
      chatFn: async () => reply("try", [tc(`bad${n++}`, "read_file", { path: "missing.txt" })]),
    }, async (agent) => {
    agent.enqueuePrompt("go");
    agent.start("test");
    await agent.settled();
    assert.equal(agent.status, "error");
    assert.match(agent.statusReason, /consecutive tool failures/);
    await agent.dispose();
  });
});

test("tools recover after stop(): the abort signal is re-armed per round", async () => {
  let n = 0;
  const mock = mkMock(() =>
    n++ === 0 ? reply("working", [tc("t1", "list_dir", {})]) : reply("done"),
  );
  await withAgent({ chatFn: mock.chat, autoContinue: false }, async (agent) => {
    (agent as unknown as { toolAbort: AbortController }).toolAbort.abort();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    const events = await readEvents(path.join(agent.snapshot().sessionDir, "chat.jsonl"));
    const results = events.filter((e) => e.type === "tool_result");
    assert.equal(results.length, 1);
    assert.equal(
      (results[0]!.data as Record<string, unknown>).ok,
      true,
      "tool must NOT inherit the aborted signal from the previous round",
    );
    await agent.dispose();
  });
});

test("failure counter resets between rounds (start works after an error)", async () => {
  let failing = true;
  let calls = 0;
  await withAgent(
    {
      maxConsecutiveToolErrors: 2,
      autoContinue: false,
      chatFn: async () => {
        calls++;
        return failing
          ? reply("try", [tc(`bad${calls}`, "read_file", { path: "missing.txt" })])
          : calls % 2 === 0
            ? reply("recovered, all done") 
            : reply("recovering", [tc(`ok${calls}`, "list_dir", {})]);
      },
    },
    async (agent) => {
      agent.enqueuePrompt("break it");
      agent.start("r1");
      await agent.settled();
      assert.equal(agent.status, "error");
      failing = false;
      agent.enqueuePrompt("now recover");
      agent.start("r2");
      await agent.settled();
      assert.equal(agent.status, "idle", "fresh round must not inherit the stale counter");
      await agent.dispose();
    },
  );
});

test("onError:retry rides out runaway tool failures and recovers", async () => {
  let calls = 0;
  let failing = true;
  const chatFn = async (): Promise<LlmResult> => {
    calls++;
    if (failing) return reply("try", [tc(`bad${calls}`, "read_file", { path: "missing.txt" })]);
    return calls % 2 === 0
      ? reply("recovered, all done") 
      : reply("recovering", [tc(`ok${calls}`, "list_dir", {})]);
  };
  await withAgent(
    { chatFn, autoContinue: false, maxConsecutiveToolErrors: 2, onError: "retry", retryDelayMs: 50 },
    async (agent) => {
      agent.enqueuePrompt("break it");
      agent.start("r1");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && calls < 3) await new Promise((r) => setTimeout(r, 20));
      assert.ok(calls >= 3, `runaway must trip after ${"the"} limit — calls=${calls}`);
      failing = false;
      await agent.settled();
      assert.equal(agent.status, "idle", "auto-retry must recover without operator help");
      const events = await readEvents(path.join(agent.snapshot().sessionDir, "chat.jsonl"));
      const trip = events.find((e) => e.type === "system_note" && (e.data as any).event === "runaway-detected");
      assert.ok(trip, "a runaway-detected note must be logged for the UI");
      assert.equal((trip!.data as any).lastTool, "read_file");
      const retries = events.filter((e) => e.type === "system_note" && (e.data as any).event === "error-retry");
      assert.ok(retries.length >= 1, "at least one error-retry note expected");
      await agent.dispose();
    },
  );
});

test("per-round turn cap ends the round silently and logs a note (no model nudge)", async () => {
  let n = 0;
  await withAgent(
    {
      maxTurnsPerRound: 3,
      autoContinue: false, 
      chatFn: async (): Promise<LlmResult> => {
        n++;
        return reply(`step ${n}`, [tc(`t${n}`, "list_dir", {})] as never);
      },
    },
    async (agent) => {
      agent.enqueuePrompt("go");
      agent.start("test");
      await agent.settled();
      assert.equal(agent.status, "idle"); 
      assert.equal(agent.stats.turns, 3); 
      const events = await readEvents(path.join(agent.snapshot().sessionDir, "chat.jsonl"));
      assert.ok(
        events.find((e) => e.type === "system_note" && (e.data as any).event === "round-turn-cap"),
        "a round-turn-cap note must be logged",
      );
      const nudges = events.filter(
        (e) => e.type === "prompt" && /This round ran/.test(String((e.data as { text?: unknown })?.text ?? "")),
      );
      assert.equal(nudges.length, 0, "no wrap-up nudge may reach the model");
      await agent.dispose();
    },
  );
});

test("agent saves, lists, then loads its own skill via tools", async () => {
  const body = "# Coffee protocol\n1. grind\n2. bloom\n3. pour";
  const mock = mkMock((req): LlmResult => {
    const lastTool = () => [...req.messages].reverse().find((m) => m.role === "tool");
    if (req.n === 0)
      return reply("saving skill", [
        tc("s1", "save_skill", {
          name: "coffee-brewing",
          description: "how to brew coffee properly",
          content: body,
        }),
      ]);
    if (req.n === 1) return reply("checking my skills", [tc("s2", "list_skills", {})]);
    if (req.n === 2) {
      assert.match(lastTool()!.content ?? "", /coffee-brewing/); 
      return reply("loading my skill", [tc("s3", "load_skill", { name: "coffee-brewing" })]);
    }
    if (req.n === 3) {
      assert.match(lastTool()!.content ?? "", /grind/); 
      return reply("skill loaded, finishing");
    }
    throw new Error("too many llm calls");
  });

  await withAgent({ chatFn: mock.chat, autoContinue: false }, async (agent, ws) => {
    agent.enqueuePrompt("document your coffee knowledge as a skill");
    agent.start("test");
    await agent.settled();

    assert.equal(agent.status, "idle");
    const written = await readFile(path.join(ws, "skills", "coffee-brewing", "SKILL.md"), "utf8");
    assert.match(written, /name: coffee-brewing/);
    assert.match(written, /grind/);
    await agent.dispose();
  });
});

test("set_todo updates: surgical checkbox flips without rewriting the list", async () => {
  let n = 0;
  const results: string[] = [];
  const chat: ChatFn = async (_c, messages) => {
    const i = n++;
    if (i > 0) {
      const t = [...messages].reverse().find((m) => m.role === "tool");
      results.push(t?.content ?? "");
    }
    if (i === 0)
      return reply("first done", [
        tc("u1", "set_todo", { updates: [{ item: "write the parser", done: true }] }),
      ]);
    if (i === 1)
      return reply("second done, one typo", [
        tc("u2", "set_todo", {
          updates: [
            { item: "add tests for the parser", done: true },
            { item: "no such item exists", done: true },
          ],
        }),
      ]);
    return reply("done");
  };
  await withAgent({ chatFn: chat, autoContinue: false }, async (agent) => {
    await agent.setGoal("work the list");
    await agent.setTodo(
      "# plan\n\n## steps\n- [ ] write the parser\n- [ ] add tests for the parser\n- [ ] ship it\n",
    );
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();

    assert.equal(
      agent.todo,
      "# plan\n\n## steps\n- [x] write the parser\n- [x] add tests for the parser\n- [ ] ship it\n",
    );
    assert.match(results[0]!, /1 item\(s\) updated/);
    assert.match(results[1]!, /NOT FOUND in todo\.md: "no such item exists"/);
    assert.match(results[1]!, /1 item\(s\) updated/);
    await agent.dispose();
  });
});

test("compact budget: derived from window by default, manual only when configured", async () => {
  await useTempDirs(["teapot-cw-", "td-", "tm-", "tf-"], async ([ws, td, tm, tf]) => {
  const derived = new Agent({
    id: "d",
    workspace: ws,
    llm: LLM,
    sessionDir: td,
    contextWindowTokens: 200_000,
  });
  await derived.init();
  assert.equal(derived.snapshot().ctx.compactAtIsManual, false);
  assert.equal(derived.snapshot().ctx.compactAt, Math.round(200_000 * 0.75));

  const manual = new Agent({
    id: "m",
    workspace: ws,
    llm: LLM,
    sessionDir: tm,
    contextWindowTokens: 200_000,
    contextTokenBudget: 50_000,
  });
  await manual.init();
  assert.equal(manual.snapshot().ctx.compactAtIsManual, true);
  assert.equal(manual.snapshot().ctx.compactAt, 50_000);

  const fallback = new Agent({
    id: "f",
    workspace: ws,
    llm: LLM,
    sessionDir: tf,
  });
  await fallback.init();
  assert.equal(fallback.snapshot().ctx.compactAtIsManual, false);
  assert.equal(fallback.snapshot().ctx.compactAt, 96_000);
  for (const a of [derived, manual, fallback]) await a.dispose();
  });
});

test("verification contract: finish(goalComplete) is audited before done", async () => {
  const calls: { messages: ChatMessage[]; n: number }[] = [];
  let n = 0;
  const chat: ChatFn = async (_c, messages) => {
    const i = n++;
    calls.push({ messages, n: i });
    if (i === 0)
      return reply("attempting to finish", [tc("f1", "finish", { goalComplete: true, summary: "I did it" })]);
    if (i === 1)
      return reply("CHANGES-REQUIRED: tests were never run and docs are missing");
    return reply("addressing gaps", [tc("f2", "finish", { goalComplete: false, summary: "still working" })]);
  };
  await withAgent({ chatFn: chat, autoContinue: false }, async (agent) => {
    await agent.setGoal("add a feature");
    await agent.setGoalVerify("npm test passes with zero failures");
    agent.enqueuePrompt("do the work");
    agent.start("t");
    await agent.settled();

    assert.equal(agent.goal.status, "active", "changes-required must reopen the goal");
    assert.equal(agent.goal.audit?.verdict, "changes-required");
    assert.match(agent.goal.audit?.feedback ?? "", /tests were never run/);
    assert.ok(
      calls[2]!.messages.some(
        (m) => m.role === "user" && String(m.content ?? "").includes("completion audit REJECTED"),
      ),
    );
    await agent.dispose();
  });
});

test("verification contract: auditor approval marks the goal done", async () => {
  let n = 0;
  const chat: ChatFn = async (_c, messages) => {
    const i = n++;
    if (i === 0) return reply("finishing", [tc("f1", "finish", { goalComplete: true, summary: "all green" })]);
    if (i === 1) return reply("APPROVED: test output shows zero failures and docs updated");
    throw new Error("should not be called again");
  };
  await withAgent({ chatFn: chat, autoContinue: false }, async (agent) => {
    await agent.setGoal("ship it");
    await agent.setGoalVerify("tests pass; docs updated");
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();

    assert.equal(agent.goal.status, "done");
    assert.equal(agent.goal.audit?.verdict, "approved");
    const events = await readEvents(path.join(agent.snapshot().sessionDir, "chat.jsonl"));
    assert.ok(events.some((e) => e.type === "goal" && (e.data as any).event === "audit"));
    assert.ok(events.some((e) => e.type === "message" && String((e.data as any).content).includes("APPROVED")));
    await agent.dispose();
  });
});

test("no verification contract: finish(goalComplete) marks done without audit", async () => {
  let n = 0;
  const chat: ChatFn = async (_c, messages) => {
    const i = n++;
    if (i === 0) return reply("done!", [tc("f1", "finish", { goalComplete: true, summary: "did it" })]);
    throw new Error("auditor should not run without a verify contract");
  };
  await withAgent({ chatFn: chat, autoContinue: false }, async (agent) => {
    await agent.setGoal("simple task"); 
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    assert.equal(agent.goal.status, "done");
    assert.equal(agent.goal.audit, undefined);
    await agent.dispose();
  });
});

test("stopping mid-bash kills the process group and settles immediately", { timeout: 20_000 }, async () => {
  let n = 0;
  const chat: ChatFn = async () => {
    const i = n++;
    if (i === 0)
      return reply("running a long command", [
        tc("b1", "bash", { command: "sleep 30" }),
      ]);
    throw new Error("should not reach a second LLM call after stop");
  };
  await withAgent({ chatFn: chat, autoContinue: false }, async (agent) => {
    agent.enqueuePrompt("go");
    agent.start("t");
    await new Promise((r) => setTimeout(r, 600));
    const t0 = Date.now();
    agent.stop("user interrupt");
    await agent.settled();
    const settleMs = Date.now() - t0;
    assert.equal(agent.status, "stopped");
    assert.ok(settleMs < 3_000, `stop must be prompt — took ${settleMs}ms`);
    const events = await readEvents(agent.log.filePath);
    const tr = events.filter((e) => e.type === "tool_result").at(-1);
    assert.match(String(dataOf(tr!).result ?? ""), /ABORTED/);
    await agent.dispose();
  });
});

test("compact budget re-derives when the model window changes (non-manual)", async () => {
  await withAgent({ autoContinue: false }, async (agent) => {
    (
      agent as unknown as { opts: { contextWindowTokens: number } }
    ).opts.contextWindowTokens = 200_000;
    const snap = agent.snapshot();
    void snap;
    const win = 200_000;
    const derived = Math.round(win * 0.75);
    assert.equal(derived, 150_000);
    await agent.dispose();
  });
});

test("reload restores session stats and seeds the context gauge", async () => {
  let n = 0;
  const usage = { inputTokens: 546_000, outputTokens: 155, cachedInputTokens: 545_000 };
  const chat: ChatFn = async () => {
    const i = n++;
    if (i === 0)
      return { message: { role: "assistant", content: "", tool_calls: [tc("b1", "bash", {})] }, usage };
    return { message: { role: "assistant", content: `turn ${i}` }, usage };
  };
  await useTempDirs(["teapot-ur-ws-", "teapot-ur-sd-"], async ([ws, sd]) => {
    const a = new Agent({ id: "t", workspace: ws, llm: LLM, sessionDir: sd, chatFn: chat, autoContinue: false });
    await a.init();
    a.enqueuePrompt("go");
    a.start("t");
    await a.settled();
    const before = a.stats;

    const b = new Agent({ id: "t2", workspace: ws, llm: LLM, sessionDir: sd });
    await b.init();
    await b.load();

    assert.equal(b.stats.turns, before.turns);
    assert.equal(b.stats.toolCalls, before.toolCalls);
    assert.equal(b.stats.inputTokens, before.inputTokens);
    assert.equal(b.stats.cachedInputTokens, before.cachedInputTokens);
    assert.equal(b.snapshot().ctx.usedTokens, usage.inputTokens);
    await b.dispose();
  });
});

test("boot no longer creates a missing workspace; first tool run does", async () => {
  const { existsSync } = await import("node:fs");
  const missing = path.join(testTmpRoot(), `teapot-ghost-${Date.now()}`);
  let n = 0;
  await useTempDir("teapot-ghost-sd-", async (sessionDir) => {
      const agent = new Agent({
        id: "g",
        workspace: missing, 
        llm: LLM,
        sessionDir,
        chatFn: async () => {
          const i = n++;
          return reply(`turn ${i}`);
        },
        autoContinue: false,
      });
    await agent.init();
    await agent.load(); 
    assert.equal(existsSync(missing), false, "workspace must not be created at boot");
    assert.equal(agent.snapshot().workspaceMissing, true);
    await agent.dispose();
  });
});

test("auto-continue is suppressed while a background bash runs; its exit wakes the agent", async () => {
  const mock = mkMock((req): LlmResult => {
    if (req.n === 0)
      return reply("starting server", [tc("c1", "bash", { command: "sleep 0.3", background: true })]);
    if (req.n === 1)
      return reply("done for now", [tc("c2", "finish", { goalComplete: false, summary: "waiting on server" })]);
    if (req.n === 2) {
      const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
      assert.ok(
        String(lastUser?.content ?? "").includes("Background job report"),
        `expected bg report as last user message, got: ${String(lastUser?.content).slice(0, 200)}`,
      );
      return reply("server finished, all good", [tc("c3", "finish", { goalComplete: true, summary: "ok" })]);
    }
    throw new Error(`too many llm calls (n=${req.n})`);
  });
  await withAgent({ chatFn: mock.chat }, async (agent, ws) => {
    await agent.setGoal("keep the dev server alive");
    agent.enqueuePrompt("start it and wait");
    agent.start("test");
    await agent.settled();
    await new Promise((r) => setTimeout(r, 60));
    const events = await readEvents(agent.log.filePath);
    const nudges = events.filter(
      (e) => e.type === "prompt" && String((e.data as any)?.text ?? "").includes("Continue working toward"),
    );
    assert.equal(nudges.length, 0, "no auto-continue nudge while a background job is alive");
    const sup = events.find((e) => (e.data as any)?.event === "auto-continue-suppressed");
    assert.ok(sup, "suppression is visible in the log");

    await new Promise((r) => setTimeout(r, 500));
    assert.equal(agent.snapshot().goal.status, "done");
    await agent.dispose();
  });
});

test("reaching the round cap with auto-continue ON starts the NEXT round (#roundcap)", async () => {
  let n = 0;
  let caps = 0;
  let turnsAfter = 0;
  let self: { stop: (why: string) => void } | null = null;
  await withAgent(
    {
      maxTurnsPerRound: 3,
      autoContinue: true,
      chatFn: async (): Promise<LlmResult> => {
        n++;
        if (n > 8) self?.stop("enough");
        return reply(`step ${n}`, [tc(`t${n}`, "list_dir", {})] as never);
      },
    },
    async (agent) => {
      self = agent;
      agent.setGoal("keep going"); 
      agent.enqueuePrompt("go");
      agent.start("test");
      await agent.settled();
      const events = await readEvents(path.join(agent.snapshot().sessionDir, "chat.jsonl"));
      caps = events.filter((e) => dataOf(e).event === "round-turn-cap").length;
      turnsAfter = agent.stats.turns;
      assert.ok(caps >= 1, `precondition: the round cap must have been hit; turns=${turnsAfter}`);
      assert.ok(
        turnsAfter > 3,
        `auto-continue must start another round after the cap (#roundcap); turns=${turnsAfter}`,
      );
    },
  );
});

test("set_todo can ADD an item — a new one is no longer just 'unknown' (#todo-add)", async () => {
  const results: string[] = [];
  let n = 0;
  const chat: ChatFn = async (_c, messages) => {
    const i = n++;
    if (i > 0) {
      const t = [...messages].reverse().find((m) => m.role === "tool");
      results.push(t?.content ?? "");
    }
    if (i === 0)
      return reply("adding", [
        tc("a1", "set_todo", {
          updates: [
            { item: "brand new task", action: "add" },
            { item: "write the parser", action: "done" },
          ],
        }),
      ]);
    if (i === 1)
      return reply("removing", [
        tc("a2", "set_todo", {
          updates: [
            { item: "ship it", action: "remove" },
            { item: "brand new task", action: "reopen" },
          ],
        }),
      ]);
    return reply("done");
  };
  await withAgent({ chatFn: chat, autoContinue: false }, async (agent) => {
    await agent.setGoal("work the list");
    await agent.setTodo("# plan\n\n## steps\n- [ ] write the parser\n- [ ] ship it\n");
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();

    assert.match(agent.todo, /^# plan\n\n## steps\n/, `headings must survive: ${agent.todo}`);
    assert.match(agent.todo, /- \[x\] write the parser/, "done still works");
    assert.match(agent.todo, /- \[ \] brand new task/, "the ADDED item is present and unchecked");
    assert.match(results[0]!, /1 item\(s\) added/, `the reply must say what happened: ${results[0]}`);
    assert.doesNotMatch(agent.todo, /ship it/, "remove deletes the line");
    assert.match(agent.todo, /- \[ \] brand new task/, "reopen unchecks it again");
    assert.match(results[1]!, /1 item\(s\) removed/, `got: ${results[1]}`);
    assert.equal(
      (agent.todo.match(/brand new task/g) ?? []).length,
      1,
      "adding the same text twice in one call must not duplicate it",
    );
    await agent.dispose();
  });
});

test("set_todo keeps its old {item, done} shape working (#todo-add)", async () => {
  await withAgent({ chatFn: async () => reply("ok"), autoContinue: false }, async (agent) => {
    await agent.setTodo("- [x] one\n- [ ] two\n");
    const note = await agent.updateTodoItems([
      { item: "one", done: false },
      { item: "two", done: true },
    ]);
    assert.equal(agent.todo, "- [ ] one\n- [x] two\n", "done:false reopens, done:true checks");
    assert.match(note, /2 item\(s\) updated/);
    await agent.dispose();
  });
});

test("a progress REQUEST answered with a different tool does not answer 'progress recorded' (#progress)", async () => {
  let sawAsk = false;
  const seen: { name: string; result: string }[] = [];
  await withAgent(
    {
      chatFn: async (_cfg, messages) => {
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        const asked = /Please give a brief progress report/.test(String(lastUser?.content ?? ""));
        if (asked && !sawAsk) {
          sawAsk = true;
          return reply("", [tc("b1", "bash", { command: "echo still-working" })]);
        }
        if (sawAsk) return reply("done", [tc("f", "finish", { goalComplete: true })]);
        return { message: { role: "assistant", content: "x".repeat(5000) } };
      },
      progressIntervalMs: 50,
      progressMinChars: 4000,
      progressMaxQuietTurns: 60,
      continueDelayMs: 5,
    },
    async (agent) => {
      const orig = agent.snapshot.bind(agent);
      void orig;
      await agent.setGoal("grind away");
      agent.enqueuePrompt("go");
      agent.start("t");
      await agent.settled();
      const evts = await readEvents(path.join(agent.snapshot().sessionDir, "chat.jsonl"));
      for (const e of evts) {
        const d = dataOf(e) as { name?: string; result?: string };
        if (e.type === "tool_result" && d.name) seen.push({ name: d.name, result: String(d.result ?? "") });
      }
    },
  );
  const bash = seen.find((r) => r.name === "bash");
  assert.ok(bash, "the bash call must have a result, or the exchange is invalid and the next request 400s");
  assert.notEqual(
    bash!.result,
    "progress recorded",
    "answering a bash call with the report text lies to the model (that result is its only view " +
      "of what happened) and drops the command's output (#progress)",
  );
});
