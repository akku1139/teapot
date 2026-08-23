import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { Master } from "../src/master.ts";
import { bus } from "../src/bus.ts";
import type { ChatFn, LlmConfig, LlmResult } from "../src/agent/llm.ts";

const LLM: LlmConfig = { baseUrl: "http://mock", apiKey: "k", model: "m" };

const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (content: string, calls?: ReturnType<typeof tc>[]): LlmResult => ({
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
});
function mkMock(handler: (n: number) => Promise<LlmResult> | LlmResult): ChatFn {
  let n = 0;
  return async () => handler(n++);
}

async function mkAgent(more: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  const ws = await mkdtemp(path.join(tmpdir(), "sto-ws-"));
  const sess = await mkdtemp(path.join(tmpdir(), "sto-sess-"));
  const agent = new Agent({
    id: "t",
    workspace: ws,
    llm: LLM,
    sessionDir: sess,
    continueDelayMs: 10,
    ...more,
  });
  await agent.init();
  return { agent, ws, sess };
}

/* ---------- goal lives beside the log, not in the workspace ---------- */

test("setGoal writes sessionDir/goal.md and never touches the workspace", async () => {
  const { agent, ws } = await mkAgent();
  await agent.setGoal("ship it");
  assert.ok(existsSync(path.join(agent.snapshot().sessionDir, "goal.md")));
  assert.ok(!existsSync(path.join(ws, "GOAL.md")));
  await agent.dispose();
});

test("legacy workspace GOAL.md is migrated into the session dir", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "mig-ws-"));
  const sess = await mkdtemp(path.join(tmpdir(), "mig-sess-"));
  await writeFile(path.join(ws, "GOAL.md"), "Build X\n\nstatus: done\n");
  const agent = new Agent({ id: "t", workspace: ws, llm: LLM, sessionDir: sess, chatFn: mkMock(() => reply("ok")) });
  await agent.init();

  assert.equal(agent.goal.status, "done");
  assert.match(await readFile(path.join(sess, "goal.md"), "utf8"), /Build X/);
  assert.ok(!existsSync(path.join(ws, "GOAL.md"))); // moved, not copied
  await agent.dispose();
});

/* ---------- static system prompt (cache-friendly) ---------- */

test("system prompt stays byte-identical across turns even if AGENTS.md appears", async () => {
  const seen: string[] = [];
  let n = 0;
  const chat: ChatFn = async (_c, messages) => {
    seen.push(String(messages[0]?.content ?? ""));
    return n++ === 0 ? reply("go") : reply("done", [tc("f", "finish", { goalComplete: true })]);
  };
  const { agent, ws } = await mkAgent({ chatFn: chat, autoContinue: false });
  agent.enqueuePrompt("go");
  agent.start("t");
  await agent.settled();
  assert.ok(!seen[0].includes("CONVENTION_MARKER"));

  // project knowledge appearing mid-session must NOT change the prompt
  await writeFile(path.join(ws, "AGENTS.md"), "# Conventions\nCONVENTION_MARKER keep tests fast\n");
  agent.enqueuePrompt("again");
  agent.start("t2");
  await agent.settled();
  assert.equal(seen.at(-1), seen[0]); // identical bytes → prefix cache stays hot
  await agent.dispose();
});

/* ---------- on-demand state tools ---------- */

test("get_goal / read_memory return harness-managed state on demand", async () => {
  const toolResults: string[] = [];
  let n = 0;
  const chat: ChatFn = async (_c, messages) => {
    const i = n++;
    if (i > 0) {
      const t = [...messages].reverse().find((m) => m.role === "tool");
      toolResults.push(t?.content ?? "");
    }
    if (i === 0) return reply("checking goal", [tc("g1", "get_goal", {})]);
    if (i === 1) return reply("noting", [tc("m1", "set_memory", { content: "user prefers pnpm" })]);
    if (i === 2) return reply("recalling", [tc("m2", "read_memory", {})]);
    return reply("done");
  };
  const { agent } = await mkAgent({ chatFn: chat, autoContinue: false });
  await agent.setGoal("ship the thing");
  agent.enqueuePrompt("go");
  agent.start("t");
  await agent.settled();

  assert.match(toolResults[0]!, /ship the thing/);
  assert.ok(toolResults.some((r) => r.includes("prefers pnpm")));
  void rm;
  void readdir;
  await agent.dispose();
});

/* ---------- meta tools write harness-managed files ---------- */

/* ---------- meta tools write harness-managed files ---------- */

test("set_goal tool updates goal.md and the snapshot", async () => {
  const mock = mkMock((n) =>
    n === 0 ? reply("redefining", [tc("g1", "set_goal", { text: "new objective" })]) : reply("done"),
  );
  const { agent } = await mkAgent({ chatFn: mock, autoContinue: false });
  agent.enqueuePrompt("change plan");
  agent.start("t");
  await agent.settled();

  assert.equal(agent.goal.text, "new objective");
  assert.match(await readFile(path.join(agent.snapshot().sessionDir, "goal.md"), "utf8"), /new objective/);
  await agent.dispose();
});

test("set_memory tool writes memory.md; read_memory fetches it back", async () => {
  const toolResults: string[] = [];
  let n = 0;
  const chat: ChatFn = async (_c, messages) => {
    const i = n++;
    if (i > 0) {
      const t = [...messages].reverse().find((m) => m.role === "tool");
      toolResults.push(t?.content ?? "");
    }
    if (i === 0) return reply("noting", [tc("m1", "set_memory", { content: "user prefers pnpm" })]);
    if (i === 1) return reply("recalling", [tc("m2", "read_memory", {})]);
    return reply("done");
  };
  const { agent } = await mkAgent({ chatFn: chat, autoContinue: false });
  agent.enqueuePrompt("remember");
  agent.start("t");
  await agent.settled();

  const memPath = path.join(agent.snapshot().sessionDir, "memory.md");
  assert.match(await readFile(memPath, "utf8"), /prefers pnpm/);
  assert.ok(toolResults.some((r) => r.includes("prefers pnpm")));
  await agent.dispose();
});

test("a declared context window implies its own compaction budget", async () => {
  const { agent } = await mkAgent({ contextWindowTokens: 1_000_000 }); // no explicit budget
  assert.equal(agent.snapshot().ctx!.compactAt, 750_000); // ~75% of the window
  assert.equal(agent.snapshot().ctx!.window, 1_000_000);
  // explicit budget still wins over derivation
  const { agent: b } = await mkAgent({ contextWindowTokens: 1_000_000, contextTokenBudget: 10_000 });
  assert.equal(b.snapshot().ctx!.compactAt, 10_000);
  // unknown window keeps the safe default
  const { agent: c } = await mkAgent({});
  assert.equal(c.snapshot().ctx!.compactAt, 96_000);
  await agent.dispose();
  await b.dispose();
  await c.dispose();
});

test("token estimate counts CJK near 1 token/char, ASCII ~4 chars/token", async () => {
  const { agent } = await mkAgent({});
  const est = () => (agent as unknown as { estimateTokens(): number }).estimateTokens();
  (agent as unknown as { messages: unknown[] }).messages.length = 0;
  (agent as unknown as { messages: unknown[] }).messages.push({ role: "user", content: "あ".repeat(100) });
  const jp = est();
  (agent as unknown as { messages: unknown[] }).messages.length = 0;
  (agent as unknown as { messages: unknown[] }).messages.push({ role: "user", content: "a".repeat(400) });
  const en = est();
  // both should land near ~100 tokens (+ small per-message overhead)
  assert.ok(jp >= 100 && jp <= 160, `jp=${jp}`);
  assert.ok(en >= 100 && en <= 160, `en=${en}`);
  // and the old flat /4 would have scored the Japanese text ~25 — no more
  assert.ok(jp > 60, `CJK must not be divided by four: jp=${jp}`);
  await agent.dispose();
});

/* ---------- prefix-cache safety across restarts ---------- */

test("session restore reproduces byte-identical request payloads", async () => {
  const LLM2: LlmConfig = { baseUrl: "http://mock", apiKey: "k", model: "m" };
  const tc = (id: string, name: string, args: unknown) => ({
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  });
  const reply = (content: string, calls?: ReturnType<typeof tc>[]): LlmResult => ({
    message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
  });

  const livePayloads: string[] = [];
  let n = 0;
  // deliberately emit tool args with SPACES — the raw string must survive the
  // log round-trip instead of being re-canonicalized by JSON.stringify
  const RAW_ARGS = '{ "path": "a.txt", "content": "hi", "limit": 5 }';
  const chatA: ChatFn = async (_c, _m, _t) => {
    const i = n++;
    livePayloads.push(JSON.stringify(_m));
    if (i === 0)
      return {
        message: {
          role: "assistant",
          content: "writing with oddly spaced args",
          tool_calls: [{ id: "w1", type: "function" as const, function: { name: "write_file", arguments: RAW_ARGS } }],
        },
      };
    if (i === 1) return reply("noting progress", [tc("p1", "report_progress", { doing: "x", goalStatus: "ok", recent: "y" })]);
    if (i === 2) return reply("checking state", [tc("g1", "get_goal", {})]);
    if (i === 3) return reply("finishing", [tc("f1", "finish", { goalComplete: true, summary: "done deal" })]);
    throw new Error("too many calls");
  };

  const ws = await mkdtemp(path.join(tmpdir(), "cache-ws-"));
  const sess = await mkdtemp(path.join(tmpdir(), "cache-sess-"));
  const a = new Agent({ id: "t", workspace: ws, llm: LLM2, sessionDir: sess, continueDelayMs: 10, chatFn: chatA });
  await a.init();
  await a.setGoal("cache check");
  a.enqueuePrompt("go");
  a.start("t");
  await a.settled();
  assert.equal(a.status, "idle");

  const beforeBytes = JSON.stringify(
    (a as unknown as { buildMessages(): unknown }).buildMessages(),
  );
  await a.dispose();

  // restart on the same session dir; capture the very first request payload
  const restoredPayloads: string[][] = [];
  const chatB: ChatFn = async (_c, messages) => {
    restoredPayloads.push(JSON.stringify(messages));
    return reply("resumed");
  };
  const b = new Agent({ id: "t", workspace: ws, llm: LLM2, sessionDir: sess, continueDelayMs: 10, chatFn: chatB });
  await b.init();
  await b.load();

  const afterBytes = JSON.stringify(
    (b as unknown as { buildMessages(): unknown }).buildMessages(),
  );
  assert.equal(afterBytes, beforeBytes); // prefix cache survives the restart
  // and the next real request starts from that exact same prefix (+ the
  // newly queued "continue" user message at the tail)
  const continued = beforeBytes.replace(
    /\]$/,
    ',{"role":"user","content":"continue"}]',
  );
  b.enqueuePrompt("continue");
  b.start("resume");
  await b.settled();
  assert.equal(restoredPayloads[0], continued);
  await b.dispose();
});

/* ---------- feedback rules ---------- */

test("add_feedback dedupes with count escalation; get_feedback reads it", async () => {
  const toolResults: string[] = [];
  let n = 0;
  const chat: ChatFn = async (_c, messages) => {
    const i = n++;
    if (i > 0) {
      const t = [...messages].reverse().find((m) => m.role === "tool");
      toolResults.push(t?.content ?? "");
    }
    if (i === 0) return reply("noted", [tc("fb1", "add_feedback", { rule: "always run pnpm test" })]);
    if (i === 1) return reply("again?!", [tc("fb2", "add_feedback", { rule: "always run pnpm test" })]);
    if (i === 2) return reply("reading rules", [tc("fb3", "get_feedback", {})]);
    return reply("done");
  };
  const { agent } = await mkAgent({ chatFn: chat, autoContinue: false });
  agent.enqueuePrompt("remember my correction");
  agent.start("t");
  await agent.settled();
  assert.match(toolResults[0]!, /feedback rule recorded/);
  assert.match(toolResults[1]!, /count raised to 2/);
  assert.match(toolResults[2]!, /\[x2\] always run pnpm test/);
  await agent.dispose();
});

/* ---------- master: per-incarnation session dirs ---------- */

function mkMaster(dataDir: string): Master {
  return new Master(
    { port: 0, dataDir, llm: LLM, providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } }, defaultProvider: "p", agents: [] },
    "/dev/null",
  );
}

test("every appended event is broadcast on the bus (web UI freshness)", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bus-root-"));
  const ws = await mkdtemp(path.join(tmpdir(), "bus-ws-"));
  const m = mkMaster(dataDir);
  const a = await m.addAgent({ id: "b", workspace: ws, provider: "p" });

  const seen: { kind: string; event?: { type: string } }[] = [];
  const handler = (ev: unknown) => seen.push(ev as { kind: string; event?: { type: string } });
  bus.on("update", handler);
  try {
    await a.enqueuePrompt("hello"); // resolves its log append before emitting
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(
      seen.some((s) => s.kind === "event" && s.event?.type === "prompt"),
      `expected a prompt event broadcast, got: ${JSON.stringify(seen.map((s) => s.kind))}`,
    );
  } finally {
    bus.off("update", handler);
    await a.dispose();
    await m.removeAgent("b");
  }
});

test("fresh incarnation gets a clean session dir; restart reuses the latest", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sess-root-"));
  const ws = await mkdtemp(path.join(tmpdir(), "sess-ws-"));
  const m = mkMaster(dataDir);

  const a = await m.addAgent({ id: "s", workspace: ws, provider: "p" }, { fresh: true });
  const dirA = a.snapshot().sessionDir;
  assert.match(path.basename(dirA), /^s-[0-9a-f]{8}$/);
  await a.setGoal("incarnation #1"); // leaves state in dirA only
  assert.ok(existsSync(path.join(dirA, "goal.md")));

  await m.removeAgent("s"); // history kept on disk
  const b = await m.addAgent({ id: "s", workspace: ws, provider: "p" }, { fresh: true });
  const dirB = b.snapshot().sessionDir;
  assert.notEqual(dirB, dirA); // no inheritance across incarnations
  assert.equal(b.messages.length, 0); // blank slate
  assert.equal(b.goal.text, ""); // and no inherited goal
  await b.setGoal("incarnation #2");

  await b.dispose();
  await m.removeAgent("s");
  // restart (non-fresh) picks up the newest session of that agent id
  const c = await m.addAgent({ id: "s", workspace: ws, provider: "p" });
  assert.equal(c.snapshot().sessionDir, dirB);
  assert.equal(c.goal.text, "incarnation #2"); // continuity within one incarnation
  await c.dispose();
});

test("legacy flat <id>.jsonl is migrated into sessions/<id>/chat.jsonl", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "legacy-root-"));
  const ws = await mkdtemp(path.join(tmpdir(), "legacy-ws-"));
  await mkdir(path.dirname(path.join(dataDir, "s.jsonl")), { recursive: true });
  await writeFile(path.join(dataDir, "s.jsonl"), '{"v":1,"id":"e1","seq":1,"ts":"2026-01-01T00:00:00Z","agent":"s","session":"s","branch":"br0","parent":null,"type":"prompt","data":{"source":"user","text":"old"}}\n');
  const m = mkMaster(dataDir);

  const a = await m.addAgent({ id: "s", workspace: ws, provider: "p" }); // restart semantics
  const dir = a.snapshot().sessionDir;
  assert.equal(path.basename(dir), "s");
  assert.ok(existsSync(path.join(dir, "chat.jsonl")));
  await a.load(); // lazy: history is rebuilt on first interaction
  assert.ok(a.messages.length === 1 && a.messages[0].content === "old");
  assert.ok(!existsSync(path.join(dataDir, "s.jsonl"))); // moved
  await a.dispose();
  void readdir;
  void rm;
});
