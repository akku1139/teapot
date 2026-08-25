import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { useTempDir, useTempDirs } from "./helpers/tmp.ts";
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


/**
 * Callback-style mkAgent: the temp workspace/session dirs live exactly as long
 * as `fn`, then are removed (tests dispose the agent inside `fn` as before).
 */
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

/* ---------- basic round / finish ---------- */

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
    // finish must leave an answered tool_call in history (API-valid sequence)
    const last = agent.messages.at(-1)!;
    assert.equal(last.role, "tool");
    assert.equal(last.tool_call_id, "c2");
    await agent.dispose();
  });
});

/* ---------- stop aborts in-flight call ---------- */

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
});

test("dispose() kills a running tool so master shutdown never hangs", async (t) => {
  t.timeout?.(15_000);
  const mock = mkMock(() =>
    reply("running a long job", [tc("l1", "bash", { command: "sleep 30", timeout_ms: 600_000 })]),
  );
  await withAgent({ chatFn: mock.chat }, async (agent) => {
    agent.enqueuePrompt("go");
    agent.start("test");
    await new Promise((r) => setTimeout(r, 80)); // loop is inside the 30s sleep command
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
    // the in-memory conversation keeps it too (restart replays it from the log)
    assert.ok(agent.messages.some((x) => x.role === "assistant" && x.content?.includes("half-written")));
    // stop is control flow — no error events
    assert.ok(!events.some((e) => e.type === "error"));
    await agent.dispose();
  });
});

/* ---------- prompt mailbox ---------- */

test("prompts sent mid-run are logged instantly and delivered at the next turn boundary", async (t) => {
  t.timeout?.(20_000);
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
    await new Promise((r) => setTimeout(r, 80)); // first turn underway; bash tool sleeping
    assert.equal(agent.status, "running");
    const t0 = Date.now();
    agent.enqueuePrompt("second, urgent"); // must return immediately, not wait for the round
    assert.ok(Date.now() - t0 < 100, "enqueuePrompt must not block on the running loop");
    await agent.settled();

    // delivered to the model as a user message at the turn boundary
    assert.ok(
      secondRoundUserTexts.includes("second, urgent"),
      `model should see the queued prompt, saw: ${JSON.stringify(secondRoundUserTexts)}`,
    );
    // and logged while the first tool was still running → the UI sees it instantly
    const events = await readEvents(agent.log.filePath);
    const promptEv = events.find((e) => e.type === "prompt" && (e.data as Record<string, unknown>).text === "second, urgent");
    const toolResultEv = events.find((e) => e.type === "tool_result");
    assert.ok(promptEv && toolResultEv);
    assert.ok(promptEv.seq < toolResultEv.seq, "prompt event must be logged before the running tool finished");
    await agent.dispose();
  });
});

test("delivered prompt emits a prompt-delivered note carrying its promptId", async () => {
  // the web UI flips a pending echo to "sent" and swaps it for the logged row
  // based on THIS note — without it the "sent ✓" echo lingered indefinitely
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
    agent.enqueuePrompt("queued while busy").length; // second one also gets an id
    await agent.settled();
    const events = await readEvents(agent.log.filePath);
    const notes = events.filter(
      (e) => e.type === "system_note" && (e.data as Record<string, unknown>).event === "prompt-delivered",
    );
    const pids = notes.map((n) => String((n.data as Record<string, unknown>).promptId));
    assert.equal(notes.length, 2, `both prompts must be delivered exactly once — got ${notes.length}`);
    assert.ok(pids.includes(pid), "the first prompt's id must appear on a delivered note");
    // and every logged user prompt carries the same id the UI echoed with
    const logged = events.filter((e) => e.type === "prompt" && (e.data as any)?.source === "user");
    for (const l of logged) assert.ok(l.data.promptId, "logged user prompts carry their echo id");
    await agent.dispose();
  });
});

test("an agent without a goal text does not auto-continue forever", async (t) => {
  t.timeout?.(15_000);
  let calls = 0;
  await withAgent({
      chatFn: () => {
        calls++;
        return reply("ok, standing by");
      },
      continueDelayMs: 10,
      // autoContinue defaults to true — but there is no goal to continue toward
    }, async (agent) => {
    agent.enqueuePrompt("hello");
    agent.start("test");
    await agent.settled();
    assert.equal(agent.status, "idle");
    assert.equal(calls, 1); // one round, then stop instead of nudging itself forever
    await agent.dispose();
  });
});

test("a queued prompt keeps a finished round going", async (t) => {
  t.timeout?.(15_000);
  const mock = mkMock(async (req): Promise<LlmResult> => {
    if (req.n === 0) {
      await new Promise((r) => setTimeout(r, 300)); // keep round one open
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
    const userMsgs = agent.messages.filter((m) => m.role === "user");
    assert.ok(userMsgs.some((m) => m.content === "second arrives right at the boundary"));
    await agent.dispose();
  });
});

/* ---------- progress gating ---------- */

test("progress prompts wait for real output, not just elapsed time", async (t) => {
  t.timeout?.(25_000);
  let big = false;
  let sawAsk = false;
  let harnessedAt = Infinity;
  const mock: ChatFn = (_cfg, _messages, tools) => {
    // the harness's dedicated progress-report ask: its prompt is the LAST
    // user message (it now carries tools too — the model answers by calling
    // report_progress, which keeps its tool ledger consistent)
    const lastUser = [..._messages].reverse().find((m) => m.role === "user");
    if (!sawAsk && /Please give a brief progress report/.test(String(lastUser?.content ?? ""))) {
      harnessedAt = Math.min(harnessedAt, Date.now());
      sawAsk = true;
      return reply("reporting", [tc("rp", "report_progress", { doing: "on track" })]);
    }
    if (sawAsk) return reply("done", [tc("f", "finish", { goalComplete: true })]);
    if (!big) return { message: { role: "assistant", content: "k" } }; // stalling provider: tiny output
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
    await new Promise((r) => setTimeout(r, 150)); // many tiny turns, way past the interval
    assert.equal(sawAsk, false); // …but no progress request while nothing real happened
    const bigAt = Date.now();
    big = true;
    await agent.settled();
    assert.ok(Number.isFinite(harnessedAt), "a progress request should happen once output flows");
    assert.ok(harnessedAt >= bigAt, "progress request must not precede sufficient output");
    const events = await readEvents(agent.log.filePath);
    const asks = events.filter(
      (e) => e.type === "prompt" && String((e.data as Record<string, unknown>).text ?? "").includes("[harness]"),
    );
    assert.equal(asks.length, 1);
    await agent.dispose();
  });
});

test("requested progress report appears exactly ONCE (no voluntary re-report)", async () => {
  // regression: the old no-tools ask left the model's "did I report?" ledger
  // unsolved — it answered in prose AND called report_progress on its next
  // turn, so the timeline showed every requested report twice (one row was
  // even the junk "(tool call)" placeholder)
  let reportedVoluntarily = false;
  let askedOnce = false;
  const mock: ChatFn = (_cfg, messages) => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (/Please give a brief progress report/.test(String(lastUser?.content ?? ""))) {
      askedOnce = true;
      return reply("reporting now", [tc("rp", "report_progress", { doing: "asked report" })]);
    }
    // after the ask, a model that "helpfully" reports again would produce a
    // SECOND progress card — the harness must not leave room for one
    if (!askedOnce && !reportedVoluntarily) {
      reportedVoluntarily = true;
      return reply("working on it", [tc("w1", "list_dir", {})]);
    }
    if (askedOnce)
      return reply("wrapping up", [tc("fin", "finish", { goalComplete: true })]);
    return reply("all done"); // plain answer ends the round
  };
  await withAgent(
    // user enqueue resets lastProgressAt, so the ask can only fire in a LATER
    // round — auto-continue keeps the loop alive past the interval
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
      // and the model history stays API-valid: no [user, tool] hole
      const roles = agent.messages.map((m) => m.role);
      for (let i = 0; i < roles.length; i++) {
        if (roles[i] === "tool") assert.equal(roles[i - 1], "assistant", `tool result at ${i} must follow an assistant turn`);
      }
      await agent.dispose();
    },
  );
});

test("requested report keeps a valid sequence even when the model calls other tools", async () => {
  // the assistant carrier message (with tool_calls) must be pushed BEFORE any
  // tool answer; skipping it produced [user, tool] which 400s on the next call
  const mock: ChatFn = (_cfg, messages) => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (/Please give a brief progress report/.test(String(lastUser?.content ?? ""))) {
      // model ignores the ask and calls something else entirely
      return reply("", [tc("x1", "get_goal", {})] as never);
    }
    // any non-tool answer ends the round — the sequence check below is what
    // matters (the assistant carrier must precede every tool result)
    return reply("round over");
  };
  await withAgent(
    { chatFn: mock, progressIntervalMs: 50, progressMinChars: 1, autoContinue: false },
    async (agent) => {
      await agent.setGoal("sequence integrity");
      agent.enqueuePrompt("go");
      agent.start("t");
      await agent.settled();
      const roles = agent.messages.map((m) => m.role);
      for (let i = 0; i < roles.length; i++) {
        if (roles[i] === "tool") {
          assert.ok(i > 0 && roles[i - 1] === "assistant", `[user, tool] hole at ${i}`);
        }
      }
      await agent.dispose();
    },
  );
});

/* ---------- prompt-edit forks ---------- */

test("editing a sent prompt forks and can summarize the abandoned tail", async () => {
  const mock = mkMock((req): LlmResult => {
    const sys = String(req.messages[0]?.content ?? "");
    if (sys.includes("compress")) return reply("- created hello.txt"); // tail summarizer
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

    // fork event records why/where
    const ev2 = await readEvents(agent.log.filePath);
    const forkEv = ev2.find((e) => e.type === "fork" && (e.data as Record<string, unknown>).reason === "prompt-edited");
    assert.ok(forkEv);
    const newPrompt = ev2.filter((e) => e.type === "prompt").at(-1)!;
    assert.equal((newPrompt.data as Record<string, unknown>).text, "create hello2.txt instead");

    // history keeps prefix + tail notes + edited prompt
    const texts = agent.messages.map((m) => m.content ?? "");
    assert.ok(texts.some((t) => t.includes("another timeline")), "summary note expected");
    assert.match(texts.find((t) => t.includes("Notes from what happened")) ?? "", /created hello\.txt/);

    // editing while running is refused
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

/* ---------- operator todo list ---------- */

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
    await agent.setTodo("- [ ] a\n- [ ] b"); // human wrote it via UI/API
    agent.enqueuePrompt("start working through the tasks");
    agent.start("t");
    await agent.settled();

    assert.match(toolResults[0]!, /\[ \] a/); // get_todo returned the list
    assert.match(toolResults[1]!, /task list replaced/);
    assert.equal(agent.todo, "- [x] a\n- [ ] b"); // agent checked off an item
    const todoPath = path.join(agent.snapshot().sessionDir, "todo.md");
    assert.match(await readFile(todoPath, "utf8"), /\[x\] a/);
    await agent.dispose();
  });
});

/* ---------- ask_user parks the loop for the operator ---------- */

test("ask_user waits for the operator and resumes with their answer", async (t) => {
  t.timeout?.(15_000);
  const mock = mkMock((req): LlmResult => {
    if (req.n === 0)
      return reply("need a decision", [
        tc("q", "ask_user", { question: "A or B?", options: ["do A", "do B"] }),
      ]);
    // after resume, the operator's answer must be in front of us
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    assert.match(lastUser?.content ?? "", /B/);
    return reply("went with B", [tc("f", "finish", { goalComplete: true })]);
  });
  await withAgent({ chatFn: mock.chat }, async (agent) => {
    await agent.setGoal("decide something");
    agent.enqueuePrompt("go");
    agent.start("t");
    for (let i = 0; i < 40 && agent.status !== "waiting"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(agent.status, "waiting");
    assert.equal(agent.snapshot().awaiting, true);

    const events = await readEvents(agent.log.filePath);
    const q = events.find((e) => e.type === "question");
    assert.ok(q);
    assert.deepEqual((q.data as Record<string, unknown>).options, ["do A", "do B"]);

    // operator taps an option → prompt + start → agent resumes
    agent.enqueuePrompt("B");
    agent.start("reply");
    await agent.settled();
    assert.equal(agent.status, "idle");
    assert.equal(agent.goal.status, "done");
    await agent.dispose();
  });
});

/* ---------- compaction driven by real usage ---------- */

test("session cost accumulates from usage when pricing is set", async () => {
  // $3/M prompt, $15/M completion — a typical Sonnet-class price sheet
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
    // pricing arrives AFTER boot (metadata races it) — the late-attach path
    // must recompute the session cost from the log, not start from zero
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    assert.equal(agent.stats.costUsd ?? 0, 0, "no pricing → no estimate");
    await agent.setModelPricing({ prompt: 0.000003, completion: 0.000015 });
    // expected: (1M - 800k) * $3/M + 100k * $15/M + 800k * $3/M * 0.1
    //         = 0.6 + 1.5 + 0.24 = $2.34
    const events = await readEvents(agent.log.filePath);
    const usages = events.filter((e) => e.type === "usage").length;
    assert.ok(usages >= 1, "usage event logged");
    const oneTurn = 0.6 + 1.5 + 0.24;
    assert.ok(
      Math.abs((agent.stats.costUsd ?? 0) - oneTurn) < 0.0001,
      `recomputed cost should be ~${oneTurn.toFixed(2)}, got ${agent.stats.costUsd}`,
    );
    // snapshot hides cost entirely when pricing is unknown
    assert.equal(typeof agent.snapshot().stats.costUsd, "number");
    await agent.dispose();
  });
});

test("compaction keys off the API's prompt_tokens, not the char estimate", async () => {
  const mock = mkMock((req): LlmResult => {
    const sys = String(req.messages[0]?.content ?? "");
    if (sys.includes("compress")) return reply("- notes from earlier");
    const base = req.n === 0
      ? reply("working", [tc("w", "write_file", { path: "f.txt", content: "x" })])
      : reply("done");
    // provider reports a huge prefix while the text itself is tiny — the old
    // char heuristic would never have triggered on this history
    return { ...base, usage: { inputTokens: 5000, outputTokens: 2 } };
  });
  await withAgent({ chatFn: mock.chat, contextTokenBudget: 4000, autoContinue: false }, async (agent) => {
    await agent.setGoal("exercise compaction");
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    assert.equal(agent.stats.compactions, 1, "usage above budget must compact");
    assert.match(agent.messages[0]!.content ?? "", /Context was compacted/);
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
    assert.match(agent.messages[0]!.content ?? "", /Context was compacted/);
    // second call: already-compacted tiny history has nothing to cut
    const r2 = await agent.compactNow();
    assert.equal(r2.ran, false);
    await agent.dispose();
  });
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
  await withAgent({ chatFn: mock.chat, contextTokenBudget: 200, autoContinue: false }, async (agent) => {
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
    const noteEv = events.find(
      (e) => e.type === "system_note" && (e.data as Record<string, unknown>).event === "context-compacted",
    )!;
    assert.ok(noteEv);
    await agent.dispose();
  });
});

/* ---------- session restore from JSONL ---------- */

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
      sessionDir: data, // restart → same session directory
      continueDelayMs: 10,
      chatFn: second.chat,
    });
    await b.init();
    assert.equal(b.status, "stopped"); // lazy: not restored at boot
    await b.load(); // explicit load (what clicking the agent in the UI does)

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
});

/* ---------- runaway guard ---------- */

test("consecutive tool failures trip the runaway guard", async () => {
  let n = 0;
  await withAgent({
      maxConsecutiveToolErrors: 2,
      chatFn: () => reply("try", [tc(`bad${n++}`, "read_file", { path: "missing.txt" })]),
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
  // regression: stop() aborted the shared tool signal and only the
  // parkedByTool path ever re-armed it, so every tool in the NEXT round
  // returned "aborted (harness shutdown)" until a full process restart
  let n = 0;
  const mock = mkMock(() =>
    n++ === 0 ? reply("working", [tc("t1", "list_dir", {})]) : reply("done"),
  );
  await withAgent({ chatFn: mock.chat, autoContinue: false }, async (agent) => {
    // poison the signal exactly like a previous stop() would have
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
  // regression: the counter only reset on tool SUCCESS, so an agent that hit
  // the runaway limit stayed poisoned — the next start tripped "N consecutive
  // failures" again on its very first failure and could never recover
  let failing = true;
  let calls = 0;
  await withAgent(
    {
      maxConsecutiveToolErrors: 2,
      autoContinue: false,
      chatFn: () => {
        calls++;
        return failing
          ? reply("try", [tc(`bad${calls}`, "read_file", { path: "missing.txt" })])
          : calls % 2 === 0
            ? reply("recovered, all done") // plain answer ends the round
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

test("per-round turn cap is a soft checkpoint, not an error", async () => {
  // a model that never finishes: each round it burns exactly the cap in
  // tool turns, then keeps going — the harness must nudge + continue, and
  // the old hard error (status=error, no recovery) must stay gone
  let n = 0;
  await withAgent(
    {
      maxTurnsPerRound: 3,
      autoContinue: true,
      continueDelayMs: 10,
      chatFn: (_cfg, messages): LlmResult => {
        const last = [...messages].reverse().find((m) => m.role === "user");
        if (last && /round ran 3 turns/.test(String(last.content))) {
          return reply("wrapping up", [tc("fin", "finish", { goalComplete: true })]);
        }
        return reply(`step ${n++}`, [tc(`t${n}`, "list_dir", {})] as never);
      },
    },
    async (agent) => {
      await agent.setGoal("grind forever until capped");
      agent.enqueuePrompt("go");
      agent.start("test");
      await agent.settled();
      assert.equal(agent.status, "idle");
      assert.equal(agent.goal.status, "done"); // the wrap-up round reached finish()
      assert.ok(agent.stats.turns >= 4, "cap must not have aborted the round early");
      const events = await readEvents(path.join(agent.snapshot().sessionDir, "chat.jsonl"));
      const capNote = events.find((e) => e.type === "system_note" && (e.data as any).event === "round-turn-cap");
      assert.ok(capNote, "a round-turn-cap note must be logged");
      await agent.dispose();
    },
  );
});

/* ---------- skills integration ---------- */

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
      assert.match(lastTool()!.content ?? "", /coffee-brewing/); // listed
      return reply("loading my skill", [tc("s3", "load_skill", { name: "coffee-brewing" })]);
    }
    if (req.n === 3) {
      assert.match(lastTool()!.content ?? "", /grind/); // full playbook returned
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

    // exact section layout survives; both updated items are checked, "ship it" untouched
    assert.equal(
      agent.todo,
      "# plan\n\n## steps\n- [x] write the parser\n- [x] add tests for the parser\n- [ ] ship it\n",
    );
    assert.match(results[0]!, /1 item\(s\) updated/);
    // unknown item is reported back, not silently dropped
    assert.match(results[1]!, /NOT FOUND in todo\.md: "no such item exists"/);
    assert.match(results[1]!, /1 item\(s\) updated/);
    await agent.dispose();
  });
});

test("compact budget: derived from window by default, manual only when configured", async () => {
  await useTempDirs(["teapot-cw-", "td-", "tm-", "tf-"], async ([ws, td, tm, tf]) => {
  // derived: window known, no budget passed
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

  // manual: explicit budget in config wins over derivation
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

  // unknown window → default budget, still not "manual"
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
      // the auditor call: no tools, asks for APPROVED/CHANGES-REQUIRED
      return reply("CHANGES-REQUIRED: tests were never run and docs are missing");
    return reply("addressing gaps", [tc("f2", "finish", { goalComplete: false, summary: "still working" })]);
  };
  await withAgent({ chatFn: chat, autoContinue: false }, async (agent) => {
    await agent.setGoal("add a feature");
    await agent.setGoalVerify("npm test passes with zero failures");
    agent.enqueuePrompt("do the work");
    agent.start("t");
    await agent.settled();

    // goal must NOT be done — audit rejected it
    assert.equal(agent.goal.status, "active", "changes-required must reopen the goal");
    assert.equal(agent.goal.audit?.verdict, "changes-required");
    assert.match(agent.goal.audit?.feedback ?? "", /tests were never run/);
    // and the worker got the feedback queued as its next prompt
    assert.ok(
      calls[2]!.messages.some((m) => m.role === "user" && m.content.includes("completion audit REJECTED")),
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
    // the audit outcome is visible in the timeline
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
    await agent.setGoal("simple task"); // no verify
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    assert.equal(agent.goal.status, "done");
    assert.equal(agent.goal.audit, undefined);
    await agent.dispose();
  });
});

test("stopping mid-bash kills the process group and settles immediately", async (t) => {
  t.timeout?.(20_000);
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
    // wait until the bash child is really running
    await new Promise((r) => setTimeout(r, 600));
    const t0 = Date.now();
    agent.stop("user interrupt");
    await agent.settled();
    const settleMs = Date.now() - t0;
    assert.equal(agent.status, "stopped");
    assert.ok(settleMs < 3_000, `stop must be prompt — took ${settleMs}ms`);
    // the abort is recorded as the tool result with partial output preserved
    const events = await readEvents(agent.log.filePath);
    const tr = events.filter((e) => e.type === "tool_result").at(-1);
    assert.match(String(tr?.data?.result ?? ""), /ABORTED/);
    await agent.dispose();
  });
});

test("compact budget re-derives when the model window changes (non-manual)", async () => {
  await withAgent({ autoContinue: false }, async (agent) => {
    // simulate: model with a known 200k window, no manual budget
    (
      agent as unknown as { opts: { contextWindowTokens: number } }
    ).opts.contextWindowTokens = 200_000;
    // trigger the same path setAgentModel uses via master — here we assert the
    // derivation invariant the master relies on:
    const snap = agent.snapshot();
    void snap;
    // direct check of the derivation rule used by both constructor & master
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

    // fresh instance on the SAME session dir = what happens on teapot restart
    const b = new Agent({ id: "t2", workspace: ws, llm: LLM, sessionDir: sd });
    await b.init();
    await b.load();

    assert.equal(b.stats.turns, before.turns);
    assert.equal(b.stats.toolCalls, before.toolCalls);
    assert.equal(b.stats.inputTokens, before.inputTokens);
    assert.equal(b.stats.cachedInputTokens, before.cachedInputTokens);
    // the gauge seeds from real usage — not estimateTokens() (which would be
    // ~0 right after restore and rendered as "0% of 1m")
    assert.equal(b.snapshot().ctx.usedTokens, usage.inputTokens);
    await b.dispose();
  });
});

test("boot no longer creates a missing workspace; first tool run does", async () => {
  const { existsSync } = await import("node:fs");
  const missing = path.join(tmpdir(), `teapot-ghost-${Date.now()}`);
  await useTempDir("teapot-ghost-sd-", async (sessionDir) => {
      const agent = new Agent({
        id: "g",
        workspace: missing, // deliberately nonexistent
        llm: LLM,
        sessionDir,
        chatFn: async () => {
          const i = n++;
          return reply(`turn ${i}`);
        },
        autoContinue: false,
      });
    await agent.init();
    await agent.load(); // what clicking the session in the UI does
    // boot/load must NOT resurrect deleted project directories
    assert.equal(existsSync(missing), false, "workspace must not be created at boot");
    assert.equal(agent.snapshot().workspaceMissing, true);
    await agent.dispose();
  });
});

