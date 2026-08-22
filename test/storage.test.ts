import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../src/agent/agent.ts";
import { Master } from "../src/master.ts";
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

/* ---------- master: per-incarnation session dirs ---------- */

function mkMaster(dataDir: string): Master {
  return new Master(
    { port: 0, dataDir, llm: LLM, providers: { p: { baseUrl: "http://x", apiKey: "k", model: "m" } }, defaultProvider: "p", agents: [] },
    "/dev/null",
  );
}

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
  assert.ok(a.messages.length === 1 && a.messages[0].content === "old");
  assert.ok(!existsSync(path.join(dataDir, "s.jsonl"))); // moved
  await a.dispose();
  void readdir;
  void rm;
});
