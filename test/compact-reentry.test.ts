import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { isSummarizerRequest } from "./helpers/summarizer-request.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dataOf = (e: { data?: unknown }) => (e.data ?? {}) as Record<string, unknown>;
const reply = (content: string): LlmResult => ({ message: { role: "assistant" as const, content } });

/** History big enough that `safeCut` can find a prefix to compact. */
const history = (n = 40) => {
  const msgs: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = 0; i < n; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `msg ${i} — filler` });
  return msgs;
};

test("a message that arrives during a compaction is PENDING, never lost", async () => {
  /**
   * Operator question: "compact中にメッセージが来たらちゃんとpendingになる?" — the summarizer call is minutes of
   * in-flight work on some sessions, so a prompt typed into that window must queue.
   *
   * It does, and the reason is structural rather than incidental: `enqueuePrompt` only appends to `pendingPrompts`,
   * and draining happens at the START of a turn — but a test is the only thing that keeps that true, so this pins
   * both halves: the prompt is queued while the summarizer is blocked, and it reaches the model afterwards.
   */
  await useTempDirs(["cr1-", "cr1b-"], async ([ws, sd]) => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const a = new Agent({
      id: "c",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (_cfg: unknown, messages: any): Promise<LlmResult> => {
        if (isSummarizerRequest(messages)) {
          await blocked;
          return reply("compacted summary");
        }
        const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
        seen.push(String((last as { content?: unknown })?.content ?? ""));
        return reply("ok");
      },
      autoContinue: false,
    } as never) as Agent;
    try {
      await a.init();
      await a.setGoal("g");
      (a as unknown as { messages: unknown[] }).messages = history();

      let done = false;
      const p = a.compactNow().then(() => {
        done = true;
      });
      const deadline = Date.now() + 8000;
      while (!done && a.snapshot().ctx?.compacting !== "summarizing" && Date.now() < deadline) await wait(10);
      assert.equal(done, false, "precondition: the compaction is in flight");

      a.enqueuePrompt("typed while compacting", "user");
      assert.equal(a.snapshot().pendingPrompts, 1, "the prompt is pending, not dropped and not merged into the summary");

      release();
      await Promise.race([p, wait(5000)]);
      assert.equal(done, true, "the compaction finished");

      a.start("test");
      const until = Date.now() + 8000;
      while (!seen.some((s) => s.includes("typed while compacting")) && Date.now() < until) await wait(10);
      assert.ok(
        seen.some((s) => s.includes("typed while compacting")),
        `the pending prompt reached the model after the compaction (saw: ${JSON.stringify(seen).slice(0, 200)})`,
      );
    } finally {
      release();
      await a.dispose().catch(() => {});
    }
  });
});

test("a second compact request during one in flight does not compact twice", async () => {
  /**
   * Operator question: "(auto-)compact中にmanual compactを走らせるとどうなる?".
   *
   * `compactNow` and the round loop share one `runChain`, so the request QUEUES instead of interleaving, and a
   * manual compact whose history did not grow since the last one returns without calling the summarizer again
   * (`messages.length <= compactedAtLen`). Two summaries of the same slice would double the cost and could cut the
   * history twice.
   */
  await useTempDirs(["cr2-", "cr2b-"], async ([ws, sd]) => {
    let summarizerCalls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const a = new Agent({
      id: "c",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (_cfg: unknown, messages: any): Promise<LlmResult> => {
        if (isSummarizerRequest(messages)) {
          summarizerCalls++;
          await blocked;
          return reply("compacted summary");
        }
        return reply("ok");
      },
      autoContinue: false,
    } as never) as Agent;
    try {
      await a.init();
      (a as unknown as { messages: unknown[] }).messages = history();
      const first = a.compactNow();
      const deadline = Date.now() + 8000;
      while (a.snapshot().ctx?.compacting !== "summarizing" && Date.now() < deadline) await wait(10);

      const second = a.compactNow(); // asked for while the first is summarizing
      release();
      await Promise.race([Promise.all([first, second]), wait(10_000)]);

      assert.equal(summarizerCalls, 1, "one summary, not two — the second request had nothing new to compact");
      assert.equal(
        (a as unknown as { stats: { compactions: number } }).stats.compactions,
        1,
        "exactly one compaction was recorded",
      );
    } finally {
      release();
      await a.dispose().catch(() => {});
    }
  });
});

test("auto-compact OFF past the budget: the next turn compacts only once it is switched back ON", async () => {
  /**
   * Operator question: "auto-compact無効化状態でバジェット超えてからauto-compactを再度有効化したり…するとどうなる?".
   *
   * `maybeCompact` reads `opts.autoCompact` on EVERY call and the API flips that same object, so re-enabling takes
   * effect on the next turn — no restart, no stale copy. While it is off, the agent does not compact however far past
   * the budget it goes; that is what "off" means.
   */
  await useTempDirs(["cr3-", "cr3b-"], async ([ws, sd]) => {
    let turns = 0;
    const a = new Agent({
      id: "c",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (_cfg: unknown, messages: any): Promise<LlmResult> => {
        if (isSummarizerRequest(messages)) return reply("compacted summary");
        turns++;
        return reply("ok");
      },
      autoContinue: false,
      autoCompact: false,
      contextTokenBudget: 64,
    } as never) as Agent;
    try {
      await a.init();
      // over budget from the start: ~40 messages of filler far past the 64-token budget
      (a as unknown as { messages: unknown[] }).messages = history(40).map((m) => ({
        ...m,
        content: `${m.content} ${"y".repeat(4000)}`,
      }));
      a.enqueuePrompt("first", "user");
      a.start("test");
      const until = Date.now() + 8000;
      while (turns < 1 && Date.now() < until) await wait(10);
      assert.equal(turns, 1, "precondition: one turn ran");
      assert.equal(
        (a as unknown as { stats: { compactions: number } }).stats.compactions,
        0,
        "auto-compact is off, so nothing was compacted even though the budget is 64 tokens",
      );

      // what `POST /api/agents/:id/autocompact` does: flip the live opts object
      (a as unknown as { opts: { autoCompact: boolean } }).opts.autoCompact = true;
      a.enqueuePrompt("second", "user");
      a.start("test");
      const until2 = Date.now() + 8000;
      while (turns < 2 && Date.now() < until2) await wait(10);
      await wait(50);
      assert.equal(
        (a as unknown as { stats: { compactions: number } }).stats.compactions,
        1,
        "switching it back on makes the NEXT turn compact — the setting is read live, not copied at construction",
      );
    } finally {
      await a.dispose().catch(() => {});
    }
  });
});

test("the compaction notice ends with the room that is left, not just the room that was used", async () => {
  /**
   * "compact後にサボりがちなので、compactの末尾にauto-continueとかと同じようにコンテキストの残量くっつけたほうがよさそう".
   *
   * A model that just watched its history be summarized reads that as "nearly out of context" and starts winding down;
   * the truth is the window was just made roomy. The number must be on the notice itself, because that is the message
   * the model is looking at when it decides whether it has budget to continue.
   */
  await useTempDirs(["cr4-", "cr4b-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "c",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async (_cfg: unknown, messages: any): Promise<LlmResult> =>
        isSummarizerRequest(messages) ? reply("compacted summary") : reply("ok"),
      autoContinue: false,
      contextTokenBudget: 4_000,
    } as never) as Agent;
    try {
      await a.init();
      // big enough that the compaction SUMMARIZES (the truncate path has no notice with a usage line)
      (a as unknown as { messages: unknown[] }).messages = history(60).map((m) => ({
        ...m,
        content: `${m.content} ${"z".repeat(3000)}`,
      }));
      await a.compactNow();
      const first = String((a as unknown as { messages: { content?: string }[] }).messages[0]?.content ?? "");
      assert.match(first, /Context was compacted/, "precondition: the checkpoint notice is the first message");
      assert.match(first, /% used \(/, "the notice must carry the usage line");
      assert.match(first, /until compaction/, "…including the room left before the next compaction");
      assert.match(first, /roomy again/, "and say which DIRECTION that is — the bare percentage was read backwards");
      /**
       * …and the SAME line must be in the log, because the notice itself never is.
       *
       * The question "did the model get the remaining budget after the compaction?" came back after a model stopped
       * claiming "残コンテキストが僅少" at 3.5% used, and a session log could not answer it at all.
       */
      const comp = (await readEvents(`${sd}/chat.jsonl`)).filter((e) => e.type === "compaction");
      assert.ok(comp.length > 0, "precondition: the compaction is logged");
      const line = String(dataOf(comp.at(-1)!)?.contextLine ?? "");
      assert.match(line, /% used/, `the note must carry the usage line (got ${JSON.stringify(line)})`);
    } finally {
      await a.dispose().catch(() => {});
    }
  });
});
