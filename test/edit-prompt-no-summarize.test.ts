import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";

/**
 * Editing an earlier prompt DISCARDS the events after it, and forks immediately.
 *
 * Two reports, one feature. MEASURED in tyb2-9-8155867c: submitting an edit while the previous one
 * was still summarizing produced a corrupted branch, because `summarize()` ran BEFORE the fork — so
 * the request blocked on a full model round trip (the lag the operator described as "かなりラグが
 * ある") and `stopRequested` was not set for the whole of it, letting a second edit read the same
 * lineage.
 *
 * Neither Pi nor OpenCode summarizes here and the operator never used it either, so the mode is gone
 * rather than made asynchronous: the fork is now synchronous apart from log I/O, and a latch refuses
 * a second edit outright.
 */
const mk = (ws: string, sd: string, onChat?: () => void) =>
  new Agent({
    id: "e1",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", model: "m" } as never,
    chatFn: (async () => {
      onChat?.();
      return { text: "ok", toolCalls: [] };
    }) as never,
    autoContinue: false,
  } as never);

async function seeded() {
  const ws = mkdtempInRootSync("editp-");
  const sd = mkdtempInRootSync("editp-s-");
  const chatCalls = { n: 0 };
  const a = mk(ws, sd, () => chatCalls.n++);
  await a.init();
  await a.log.append("prompt", "e1", "br0", { source: "user", text: "first" });
  await a.log.append("prompt", "e1", "br0", { source: "user", text: "second" });
  const evs = await readEvents(a.log.filePath);
  const prompts = evs.filter((e) => e.type === "prompt");
  return { a, first: prompts[0]!, chatCalls };
}

test("an edit forks WITHOUT calling the model (#summarize)", async () => {
  const { a, first, chatCalls } = await seeded();
  const before = chatCalls.n;
  const t0 = Date.now();
  const r = await a.editPromptAt(first.id, "edited text");
  const ms = Date.now() - t0;

  assert.equal(chatCalls.n, before, "the edit must not spend a model round trip — that was the lag");
  assert.ok(ms < 2_000, `the fork must be immediate, not a summarizer wait (took ${ms}ms)`);
  assert.ok(r.droppedEvents > 0, "the events after the edited prompt are discarded");
  assert.ok(r.branch, "and a new branch is named");
  await a.dispose();
});

test("a second edit while one is in flight is REFUSED, not raced (#summarize)", async () => {
  /**
   * The status check cannot see a concurrent call: `readEvents` and the log writes are awaits, so
   * both requests passed it, both read the same lineage and both forked. This is what corrupted the
   * session when an edit was resubmitted.
   */
  const { a, first } = await seeded();
  const results = await Promise.allSettled([
    a.editPromptAt(first.id, "edited A"),
    a.editPromptAt(first.id, "edited B"),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  assert.equal(ok.length, 1, "exactly one edit wins");
  assert.equal(refused.length, 1, "the other is refused");
  assert.match(String(refused[0]!.reason?.message ?? ""), /already in progress/, "and says why");
  await a.dispose();
});

test("the latch is released after a FAILED edit, so the agent is not wedged (#summarize)", async () => {
  const { a, first } = await seeded();
  // an event id that does not exist: the inner call throws, and the latch must still clear
  await assert.rejects(a.editPromptAt("no-such-event", "x"));
  const ok = await a.editPromptAt(first.id, "after the failure");
  assert.ok(ok.branch, "a later edit must still work");
  await a.dispose();
});
