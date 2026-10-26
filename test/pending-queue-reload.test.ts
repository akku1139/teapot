/**
 * #87 — "with a pending message, go to another session and come back: the
 * timeline no longer shows that it is pending."
 *
 * Reported as still reproducible against v0.26.3, which DID ship the first fix.
 * That fix made the echo rows per-session, so a SWITCH preserves them — but the
 * rows are memory-only (like `liveByAgent` and `timelineCache`), and the queue
 * lives on the SERVER. So after a RELOAD, or in a second tab:
 *
 *   server : pendingPromptIds = ["u1"]   — the queue is intact
 *   UI     : pendingBySession = {}       — gone with the process
 *
 * `reconcilePending` cannot bridge that: an id IDENTIFIES a prompt, it does not
 * carry its TEXT, so there is no echo to reconstruct and the queued message
 * renders as its log row alone — i.e. already sent. The badge still counts it,
 * so the two disagree, which is the reported symptom.
 *
 * So the server now also ships the queue itself, and the UI materialises an echo
 * for any prompt it does not already have one for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

/* ---------- the server ships text, not just ids ---------- */

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
    // enqueuePrompt pushes ASYNCHRONOUSLY (inside a .then), so settle before
    // snapshotting — reading too early shows an empty queue and looks like the
    // field is missing rather than merely not-yet-populated
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

/* ---------- the UI rebuild rule ---------- */

/** mirrors the rebuild effect in App.tsx */
function rebuild(
  existing: { promptId?: string; text: string; at: number }[],
  queue: { id: string; text: string; at?: number }[],
): { promptId?: string; text: string; at: number }[] {
  const have = new Set(existing.map((p) => p.promptId).filter(Boolean));
  const missing = queue.filter((q) => q.id && !have.has(q.id));
  return [...missing.map((q) => ({ promptId: q.id, text: q.text, at: q.at ?? 0 })), ...existing];
}

test("a fresh UI with no echoes rebuilds from the queue (#87)", () => {
  // the reload case: the process restarted, so nothing is in memory
  const got = rebuild([], [{ id: "u1", text: "QUEUED MESSAGE TEXT", at: 123 }]);
  assert.equal(got.length, 1, "a queued prompt must render after a reload (#87)");
  assert.equal(got[0]!.text, "QUEUED MESSAGE TEXT", "and carry its text (#87)");
});

test("an echo the UI already has is never rewritten (#87)", () => {
  // the live echo may have text, images and a position the server copy lacks;
  // overwriting it would visibly flicker the row the operator is looking at
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

