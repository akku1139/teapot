import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

test("the snapshot ships the queue WITH its text (#87)", async () => {
  await useTempDirs(["q87a-", "q87b-"], async ([ws, sd]) => {
    let n = 0;
    const agent = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        n++;
        return { message: { role: "assistant" as const, content: "ok " + "z".repeat(200) } };
      },
      autoContinue: false,
      maxTurnsPerRound: 1,
    } as never) as Agent;
    await agent.init();
    agent.enqueuePrompt("first", "user");
    agent.start("t");
    await new Promise((r) => setTimeout(r, 200));
    agent.enqueuePrompt("QUEUED MESSAGE TEXT", "user");
    await new Promise((r) => setTimeout(r, 80));

    const snap = (agent as unknown as { snapshot(): Record<string, unknown> }).snapshot() as {
      pendingPrompts: number;
      pendingPromptIds: string[];
      pendingPromptQueue: { id: string; text: string }[];
    };
    assert.equal(snap.pendingPrompts, 1, "precondition: a prompt is queued (#87)");
    assert.ok(snap.pendingPromptQueue.length, "the queue must ship (#87)");
    assert.equal(
      snap.pendingPromptQueue[0]!.text,
      "QUEUED MESSAGE TEXT",
      "with its TEXT — an id alone cannot rebuild an echo (#87)",
    );
    assert.ok(
      snap.pendingPromptIds.includes(snap.pendingPromptQueue[0]!.id),
      "and stay consistent with pendingPromptIds (#87)",
    );
    await agent.dispose();
  });
});

function rebuild(
  existing: { promptId?: string; text: string; at: number }[],
  queue: { id: string; text: string; at?: number }[],
): { promptId?: string; text: string; at: number }[] {
  const have = new Set(existing.map((p) => p.promptId).filter(Boolean));
  const missing = queue.filter((q) => q.id && !have.has(q.id));
  return [...missing.map((q) => ({ promptId: q.id, text: q.text, at: q.at ?? 0 })), ...existing];
}

test("a fresh UI with no echoes rebuilds from the queue (#87)", () => {
  const got = rebuild([], [{ id: "u1", text: "QUEUED MESSAGE TEXT", at: 123 }]);
  assert.equal(got.length, 1, "a queued prompt must render after a reload (#87)");
  assert.equal(got[0]!.text, "QUEUED MESSAGE TEXT", "and carry its text (#87)");
});

test("an echo the UI already has is never rewritten (#87)", () => {
  const existing = [{ promptId: "u1", text: "locally typed", at: 999 }];
  const got = rebuild(existing, [{ id: "u1", text: "SERVER COPY", at: 1 }]);
  assert.equal(got.length, 1, "no duplicate row (#87)");
  assert.equal(got[0]!.text, "locally typed", "the live echo wins (#87)");
});

test("the rebuild is additive, not a replacement (#87)", () => {
  const existing = [
    { promptId: "u1", text: "one", at: 2 },
    { promptId: "u2", text: "two", at: 1 },
  ];
  const got = rebuild(existing, [{ id: "u3", text: "three", at: 3 }]);
  assert.deepEqual(
    got.map((g) => g.promptId),
    ["u3", "u1", "u2"],
    "a newly-queued prompt is prepended; the rest keep their order (#87)",
  );
});

