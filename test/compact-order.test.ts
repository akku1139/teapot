import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { mkdtempInRoot } from "./helpers/tmp-root.ts";
import { Agent } from "../src/agent/agent.ts";
import type { ChatMessage, LlmResult } from "../src/agent/llm.ts";
import { readEvents } from "../src/log/events.ts";

const reply = (content: string): LlmResult => ({ message: { role: "assistant", content } });

const BIG = "Z".repeat(6_000);

function bigHistory(bigOut: string): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "user", content: "look around" } as ChatMessage];
  for (let i = 1; i <= 3; i++) {
    msgs.push({
      role: "assistant",
      content: "reading",
      tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: "{}" } }],
    } as ChatMessage);
    msgs.push({ role: "tool", tool_call_id: `c${i}`, content: bigOut } as ChatMessage);
  }
  msgs.push({ role: "assistant", content: "done" } as ChatMessage);
  return msgs;
}

const charsOf = (a: Agent) =>
  (a.conversation as ChatMessage[]).reduce((n, m) => n + (m.content?.length ?? 0), 0);

const setMessages = (a: Agent, msgs: ChatMessage[]) =>
  ((a as unknown as { messages: ChatMessage[] }).messages = msgs);

const eventNames = async (agent: Agent): Promise<string[]> =>
  (await readEvents(agent.log.filePath)).map((e) => String((e as any).data?.event ?? ""));

async function freshAgent(
  ws: string,
  sessionDir: string,
  budget: number,
  onChat: () => LlmResult,
) {
  const agent = new Agent({
    id: "t",
    workspace: ws,
    sessionDir,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
    chatFn: async () => onChat(),
    contextTokenBudget: budget,
    autoContinue: false,
  } as any);
  await agent.init();
  return agent;
}

test("a context with room left is NOT pruned (#compact-order)", async () => {
  await useTempDirs(["corder-a-", "corder-as-"], async ([ws, sessionDir]) => {
    let chatCalls = 0;
    const agent = await freshAgent(ws!, sessionDir!, 4_000, () => {
      chatCalls++;
      return reply("ok");
    });

    setMessages(agent, [
      { role: "user", content: "look around" } as ChatMessage,
      {
        role: "assistant",
        content: "reading",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      } as ChatMessage,
      { role: "tool", tool_call_id: "c1", content: "Z".repeat(3_100) } as ChatMessage,
      ...Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
        content: `turn ${i}: ${"y".repeat(400)}`,
      })),
    ]);

    const before = charsOf(agent);
    const est = (agent as any).contextSizeForBudgeting();
    assert.ok(
      est > 2_400 && est < 3_800,
      `precondition: the estimate must lie between the old bar (2400) and the new one (3800); got ${est}`,
    );
    const prunable = (agent.conversation as any[]).some(
      (m) => m.role === "tool" && String(m.content ?? "").length > 3_000,
    );
    assert.ok(prunable, "precondition: an oversized tool result must be present");

    const probeDir = await mkdtempInRoot("corder-a-probe-");
    const probe = new Agent({
      ...(agent as any).opts,
      sessionDir: probeDir,
      chatFn: async () => reply("ok"),
    } as any);
    await probe.init();
    (probe as any).messages = (agent.conversation as any[]).map((m) => ({ ...m }));
    const clipped = await (probe as any).maybePrune(true);
    await probe.dispose();
    assert.ok(
      clipped > 0,
      "precondition: the oversized result must be OUTSIDE the protected tail, or nothing could prune it",
    );

    await (agent as any).maybeCompact(false);

    assert.equal(
      charsOf(agent),
      before,
      `a context that FITS must be left alone (was ${before}, became ${charsOf(agent)})`,
    );
    const events = await eventNames(agent);
    assert.ok(
      !events.includes("context-pruned"),
      "nothing may be pruned while there is room — pruning is destructive",
    );
    assert.equal(chatCalls, 0, "and no summarize call may be made either");
    await agent.dispose();
  });
});

test("clipping alone stops the pass — no summarize, no truncate (#compact-order)", async () => {
  await useTempDirs(["corder-b-", "corder-bs-"], async ([ws, sessionDir]) => {
    let chatCalls = 0;
    const agent = await freshAgent(ws!, sessionDir!, 2_000, () => {
      chatCalls++;
      return reply("## Current work\nSUMMARY THAT SHOULD NOT BE ASKED FOR");
    });

    setMessages(agent, bigHistory(BIG));
    const before = charsOf(agent);
    assert.ok(before > 18_000, `precondition: fixture must be large; got ${before}`);

    await (agent as any).maybeCompact(false);
    const after = charsOf(agent);

    assert.ok(after < before, `the pass must reclaim room (was ${before}, became ${after})`);

    const events = await eventNames(agent);
    assert.ok(
      events.includes("context-pruned"),
      "old tool output must have been clipped — that is the cheap path",
    );
    assert.ok(
      events.includes("context-pruned-enough"),
      "the pass must RECORD that clipping alone brought it back under budget",
    );
    assert.ok(
      !events.includes("context-compaction-skipped-summarize"),
      "clipping sufficed, so a summarize was never even considered",
    );
    assert.equal(chatCalls, 0, "no LLM call may be made when clipping alone suffices");
    await agent.dispose();
  });
});

test("a MANUAL pass still summarizes even when clipping would suffice (#compact-order)", async () => {
  await useTempDirs(["corder-c-", "corder-cs-"], async ([ws, sessionDir]) => {
    let chatCalls = 0;
    const agent = await freshAgent(ws!, sessionDir!, 2_000, () => {
      chatCalls++;
      return reply("## Current work\nlooked around");
    });

    setMessages(agent, bigHistory(BIG));
    await (agent as any).maybeCompact(true);

    assert.ok(chatCalls > 0, "a manual compaction must actually ask the model for notes");
    assert.ok(
      (agent.conversation as ChatMessage[]).some((m) =>
        String(m.content ?? "").includes("## Current work"),
      ),
      "the summary must land in the history a manual pass rewrites",
    );
    await agent.dispose();
  });
});

test("short-context mode prunes EARLY, inside the budget (#161)", async () => {
  await useTempDirs(["corder-sc-", "corder-scs-"], async ([ws, sessionDir]) => {
    const agent = await freshAgent(ws!, sessionDir!, 4_000, () => reply("ok"));
    (agent as any).opts.shortContext = true;

    setMessages(agent, bigHistory("Z".repeat(3_100)));
    const before = charsOf(agent);
    const est = (agent as any).contextSizeForBudgeting();
    assert.ok(
      est > 2_400 && est < 4_000,
      `precondition: the estimate must be between short mode's bar (2400) and the budget (4000); got ${est}`,
    );

    await (agent as any).maybeCompact(false);
    const after = charsOf(agent);

    assert.ok(
      after < before,
      `short mode must prune while there is still room (was ${before}, became ${after})`,
    );
    const events = await eventNames(agent);
    assert.ok(events.includes("context-pruned"), `expected a prune: ${JSON.stringify(events)}`);
    await agent.dispose();
  });
});

test("the default mode does NOT prune at that same size (#161)", async () => {
  await useTempDirs(["corder-df-", "corder-dfs-"], async ([ws, sessionDir]) => {
    const agent = await freshAgent(ws!, sessionDir!, 4_000, () => reply("ok"));
    setMessages(agent, bigHistory("Z".repeat(3_100)));
    const before = charsOf(agent);
    await (agent as any).maybeCompact(false);
    assert.equal(charsOf(agent), before, "the default mode must leave a fitting context alone");
    const events = await eventNames(agent);
    assert.ok(!events.includes("context-pruned"), "and must emit no prune event");
    await agent.dispose();
  });
});
