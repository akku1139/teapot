import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { buildApp } from "../src/server/api.ts";
import { Master } from "../src/master.ts";
import { readEvents } from "../src/log/events.ts";
import type { LlmResult } from "../src/agent/llm.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";
import { dataOf } from "./helpers/event-data.ts";

markPosixOnly("runs POSIX commands through the bash tool");

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" } as any;
const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (content: string, calls?: ReturnType<typeof tc>[]): LlmResult => ({
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
});

function makeScriptedChat() {
  let n = 0;
  return async (_c: unknown, m: any): Promise<LlmResult> => {
    if (String(m[0]?.content ?? "").includes("compress")) return reply("- notes");
    n++;
    return n === 1
      ? reply("working", [tc("w1", "write_file", { path: "a.txt", content: "x" })])
      : reply("done");
  };
}

async function waitFor(fn: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

test("the fork event keeps the chain linked to the pre-edit history (#38)", async () => {
  await useTempDirs(["e38a-", "e38b-", "e38c-"], async ([_d, ws, sd]) => {
    const agent = new Agent({
      id: "t", workspace: ws, sessionDir: sd, llm: LLM,
      chatFn: makeScriptedChat(),
      autoContinue: false,
    } as any);
    await agent.init();
    await agent.setGoal("g");
    agent.enqueuePrompt("first");
    agent.start("t");
    await agent.settled();

    const before = await readEvents(agent.log.filePath);
    const firstPrompt = before.find((e) => e.type === "prompt")!;
    const r = await agent.editPromptAt(firstPrompt.id, "edited instead", "discard");
    assert.notEqual(r.branch, "br0", "an edit must fork");

    const after = await readEvents(agent.log.filePath);
    const byId = new Map(after.map((e) => [e.id, e]));
    let cur: any = after[after.length - 1];
    const chain: string[] = [];
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(`${cur.branch}:${cur.type}`);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    assert.ok(
      chain.some((c) => c === "br0:goal"),
      `the chain must still reach the surviving pre-edit context; got ${chain.join(" < ")} (#69)`,
    );
    assert.ok(
      !chain.includes("br0:prompt"),
      `the chain must NOT reach the DISCARDED prompt — that is the resurrection (#69); got ${chain.join(" < ")}`,
    );
    await agent.dispose();
  });
});

test("a restart after an edit keeps the pre-edit context (#38)", async () => {
  await useTempDirs(["e38d-", "e38e-", "e38f-"], async ([_d, ws, sd]) => {
    const mk = () =>
      new Agent({
        id: "t", workspace: ws, sessionDir: sd, llm: LLM,
        chatFn: makeScriptedChat(),
        autoContinue: false,
      } as any);
    const first = mk();
    await first.init();
    await first.setGoal("g");
    first.enqueuePrompt("first");
    first.start("t");
    await first.settled();
    const before = await readEvents(first.log.filePath);
    const firstPrompt = before.find((e) => e.type === "prompt")!;
    await first.editPromptAt(firstPrompt.id, "edited instead", "discard");
    await first.dispose();

    const second = mk();
    (second as unknown as { opts: { restoreSession: boolean } }).opts.restoreSession = true;
    await second.init();
    await second.ensureReady?.();
    const texts = (second as unknown as { messages: { content?: string }[] }).messages.map(
      (m) => String(m.content ?? ""),
    );
    assert.ok(
      texts.some((t) => t.includes("edited instead")),
      "the edited prompt must survive the restart (#38)",
    );
    assert.ok(
      !texts.some((t) => t.includes("first")),
      `the discarded prompt must not resurrect after a restart (#69); got ${JSON.stringify(texts)}`,
    );
    await second.dispose();
  });
});

test("editing is refused while the agent is parked on a tool (#38)", async () => {
  await useTempDirs(["e38g-", "e38h-", "e38i-"], async ([_d, ws, sd]) => {
    const agent = new Agent({
      id: "t", workspace: ws, sessionDir: sd, llm: LLM,
      chatFn: async (): Promise<LlmResult> =>
        reply("working", [tc("b1", "bash", { command: "sleep 20" })]),
      autoContinue: false,
    } as any);
    await agent.init();
    await agent.setGoal("g");
    agent.enqueuePrompt("go");
    agent.start("t");
    for (let i = 0; i < 100 && (agent as unknown as { parkedByTool: boolean }).parkedByTool === false; i++)
      await new Promise((r) => setTimeout(r, 25));

    const events = await readEvents(agent.log.filePath);
    const p = events.find((e) => e.type === "prompt");
    assert.ok(p);
    await assert.rejects(
      () => agent.editPromptAt(p!.id, "edited", "discard"),
      /running/i,
      "editing while parked must be refused (#38)",
    );
    await agent.dispose();
  });
});

test("editing is refused while prompts are still queued (#38)", async () => {
  await useTempDirs(["e38j-", "e38k-", "e38l-"], async ([_d, ws, sd]) => {
    const agent = new Agent({
      id: "t", workspace: ws, sessionDir: sd, llm: LLM,
      chatFn: async (): Promise<LlmResult> => reply("ok"),
      autoContinue: false,
    } as any);
    await agent.init();
    await agent.setGoal("g");
    agent.enqueuePrompt("first");
    agent.start("t");
    await agent.settled();
    const events = await readEvents(agent.log.filePath);
    const p = events.find((e) => e.type === "prompt");
    assert.ok(p);
    agent.enqueuePrompt("queued one");
    await waitFor(
      () => (agent as unknown as { pendingPrompts: unknown[] }).pendingPrompts.length > 0,
      "prompt never reached the pending queue",
    );
    await assert.rejects(
      () => agent.editPromptAt(p!.id, "edited", "discard"),
      /running/i,
      "editing with queued prompts must be refused (#38)",
    );
    await agent.dispose();
  });
});

test("an edit leaves no queued prompts from the old branch (#38)", async () => {
  await useTempDirs(["e38m-", "e38n-", "e38o-"], async ([_d, ws, sd]) => {
    const agent = new Agent({
      id: "t", workspace: ws, sessionDir: sd, llm: LLM,
      chatFn: async (): Promise<LlmResult> => reply("ok"),
      autoContinue: false,
    } as any);
    await agent.init();
    await agent.setGoal("g");
    agent.enqueuePrompt("first");
    agent.start("t");
    await agent.settled();

    agent.enqueuePrompt("stranded");
    await waitFor(
      () => (agent as unknown as { pendingPrompts: unknown[] }).pendingPrompts.length > 0,
      "prompt never reached the pending queue",
    );
    const events = await readEvents(agent.log.filePath);
    const first = events.find((e) => e.type === "prompt")!;
    (agent as unknown as { pendingPrompts: unknown[] }).pendingPrompts = [];
    await agent.editPromptAt(first.id, "edited", "discard");
    assert.equal(
      (agent as unknown as { pendingPrompts: unknown[] }).pendingPrompts.length,
      0,
      "no queued prompt may survive into the new branch (#38)",
    );

    const after = await readEvents(agent.log.filePath);
    const strandedRow = after.find(
      (e) =>
        e.type === "prompt" &&
        String((e.data as { text?: string })?.text ?? "") === "stranded",
    );
    assert.ok(strandedRow, "the queued prompt should still be visible as a row");
    const deliveredNote = after.find(
      (e) =>
        e.type === "system_note" &&
        (e.data as { event?: string })?.event === "prompt-delivered" &&
        dataOf(e).promptId === dataOf(strandedRow!).promptId,
    );
    assert.equal(
      deliveredNote,
      undefined,
      "a prompt queued before the edit must never be delivered into the new branch (#38)",
    );
    await agent.dispose();
  });
});

test("the fork event is attributed to the branch it CREATED (#38)", async () => {
  await useTempDirs(["e38p-", "e38q-", "e38r-"], async ([dataDir, ws]) => {
    const configPath = path.join(dataDir, "config.json");
    const m = new Master(
      {
        port: 0, dataDir, llm: LLM, providers: {}, agents: [],
      } as any,
      configPath,
    );
    const agent = await m.addAgent({ id: "t", workspace: ws }, { persist: false });
    (agent as unknown as { opts: { chatFn?: unknown; autoContinue: boolean } }).opts.chatFn =
      makeScriptedChat();
    (agent as unknown as { opts: { autoContinue: boolean } }).opts.autoContinue = false;
    await agent.setGoal("g");
    agent.enqueuePrompt("first");
    agent.start("t");
    await agent.settled();
    const events = await readEvents(agent.log.filePath);
    const first = events.find((e) => e.type === "prompt")!;
    const r = await agent.editPromptAt(first.id, "edited", "discard");

    const app = buildApp(m);
    const res = await app.request("/api/agents/t/branches");
    const body = (await res.json()) as { branches: { branch: string; forkedFrom?: unknown }[] };
    const created = body.branches.find((b) => b.branch === r.branch);
    assert.ok(created, "the new branch must appear in the branch list (#38)");
    assert.ok(
      created!.forkedFrom,
      "the new branch must carry forkedFrom — the fork must be attributed to it (#38)",
    );
    await m.stopAllAgents(2_000);
  });
});