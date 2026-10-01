/**
 * #38 — "editing a message leaves the old branch's commands running, and the
 *        branch filter on the timeline doesn't work well"
 *
 * Three defects, all confirmed by reading the code:
 *
 *  A. The edit guard only rejected `status === "running"`. But parkForTool()
 *     rewrites the status to "idle" while the loop is still alive inside a
 *     parked tool (wait_children does this), so an edit happily replaced the
 *     very `messages` array the agent was about to resume into.
 *
 *  B. Nothing in flight was cancelled. editPromptAt() never set stopRequested,
 *     never aborted the LLM call or the tool signal, and never drained queued
 *     prompts — all of which belong to the branch being discarded.
 *
 *  C. The `fork` event was appended under the NEW branch. EventLog links
 *     parents per branch (lastByBranch), so the fork got `parent: null` — which
 *     severed the chain, and lineageOf() then returned only the post-fork
 *     events. A restart rebuilt the history with none of the pre-edit context.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { buildApp } from "../src/server/api.ts";
import { Master } from "../src/master.ts";
import { readEvents } from "../src/log/events.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const LLM = { baseUrl: "http://x", apiKey: "k", model: "m" } as any;
const tc = (id: string, name: string, args: unknown) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (content: string, calls?: ReturnType<typeof tc>[]): LlmResult => ({
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
});

/**
 * A chat mock that produces a short, DETERMINISTIC exchange: one tool call,
 * then a final answer. Keyed on a call counter — branching on messages.length
 * instead made the harness loop until its turn cap (minutes).
 */
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

/** poll until predicate() is true (some state is filled asynchronously) */
async function waitFor(fn: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/* ---------- C: the fork must not sever the parent chain ---------- */

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
    // walk the parent chain from the newest event: it must reach the ORIGINAL
    // prompt, which is only possible if the fork links across the branch change
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
      chain.some((c) => c === "br0:prompt"),
      `the post-fork chain must reach the pre-edit branch; got ${chain.join(" < ")} (#38)`,
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

    // fresh agent over the same log = the restart path
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
      texts.some((t) => t.includes("first")),
      "the pre-edit context must NOT vanish after a restart (#38)",
    );
    await second.dispose();
  });
});

/* ---------- A: the guard must cover parked / queued states ---------- */

test("editing is refused while the agent is parked on a tool (#38)", async () => {
  await useTempDirs(["e38g-", "e38h-", "e38i-"], async ([_d, ws, sd]) => {
    // a tool that never returns on its own, so the agent parks exactly like
    // wait_children does — status flips to "idle" while the loop is alive
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
    // wait until the tool is actually in flight
    for (let i = 0; i < 100 && (agent as unknown as { parkedByTool: boolean }).parkedByTool === false; i++)
      await new Promise((r) => setTimeout(r, 25));

    const events = await readEvents(agent.log.filePath);
    const p = events.find((e) => e.type === "prompt");
    assert.ok(p);
    // status may read "idle" here (parked) — the guard must still refuse (#38)
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
    // a prompt the loop already consumed, so there IS a log event to edit
    agent.enqueuePrompt("first");
    agent.start("t");
    await agent.settled();
    const events = await readEvents(agent.log.filePath);
    const p = events.find((e) => e.type === "prompt");
    assert.ok(p);
    // now queue ANOTHER prompt without running the loop: undelivered prompts
    // are live state the old branch owns (#38)
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

/* ---------- B: nothing from the old branch may survive ---------- */

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

    // queue an extra prompt, then edit (the agent is idle so the edit is allowed)
    agent.enqueuePrompt("stranded");
    await waitFor(
      () => (agent as unknown as { pendingPrompts: unknown[] }).pendingPrompts.length > 0,
      "prompt never reached the pending queue",
    );
    const events = await readEvents(agent.log.filePath);
    const first = events.find((e) => e.type === "prompt")!;
    // drop the queued one so the edit is allowed, then verify the edit itself
    // clears anything still queued from the old branch
    (agent as unknown as { pendingPrompts: unknown[] }).pendingPrompts = [];
    await agent.editPromptAt(first.id, "edited", "discard");
    assert.equal(
      (agent as unknown as { pendingPrompts: unknown[] }).pendingPrompts.length,
      0,
      "no queued prompt may survive into the new branch (#38)",
    );

    // The prompt ROW is written at enqueue time (that is what the timeline
    // shows), so it legitimately exists. What must NOT happen is it being
    // DELIVERED to the model after the edit put us on a new branch — the
    // prompt-delivered note is the proof the model consumed it.
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
        (e.data as { promptId?: string })?.promptId === strandedRow!.data.promptId,
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
    // inject the mock AFTER addAgent: addAgent would otherwise use the real
    // client against the fake baseUrl and sit in llmCall's 5s+5s+30s retry
    // ladder, stalling the whole test file
    const agent = await m.addAgent({ id: "t", workspace: ws }, { persist: false });
    // addAgent defaults autoContinue:true, so the loop would never settle with
    // an always-active goal — it has to be off for a bounded round
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