/**
 * The compaction notice must be byte-identical after a restart.
 *
 * Every request's bytes are the provider's prefix-cache key, and this notice sits at the FRONT of the conversation — so a
 * notice that gains or loses a line at restore time invalidates the cache for the whole session. The operator raised it
 * the moment the usage line was added ("場合によってはprefix cacheが破壊されるので結構な問題になるんだけど").
 *
 * Two builders was the danger: the live compaction and `restoreFromLog` each composed the text, and they had already
 * drifted (the live one carried the usage line, the restored one did not). There is one builder now, and the line itself
 * is a RECORDED fact — written into the `compaction` event — not something recomputed from the current state.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { isSummarizerRequest } from "./helpers/summarizer-request.ts";
import { Agent } from "../src/agent/agent.ts";
import { readEvents } from "../src/log/events.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const reply = (content: string): LlmResult => ({ message: { role: "assistant" as const, content } });
const dataOf = (e: { data?: unknown }) => (e.data ?? {}) as Record<string, unknown>;

const history = (n: number) => {
  const msgs: { role: "user" | "assistant"; content: string }[] = [];
  for (let i = 0; i < n; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `msg ${i} ${"z".repeat(3000)}` });
  return msgs;
};

test("a restored session rebuilds the compaction notice byte for byte", async () => {
  await useTempDirs(["cns-a-", "cns-b-"], async ([ws, sd]) => {
    const make = () =>
      new Agent({
        id: "c",
        workspace: ws!,
        sessionDir: sd!,
        llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
        chatFn: async (_c: unknown, messages: any): Promise<LlmResult> =>
          isSummarizerRequest(messages) ? reply("compacted summary text") : reply("ok"),
        autoContinue: false,
        contextTokenBudget: 4_000,
      } as never) as InstanceType<typeof Agent>;

    const a = make();
    await a.init();
    (a as unknown as { messages: unknown[] }).messages = history(60);
    await a.compactNow();
    const live = String((a as unknown as { messages: { content?: string }[] }).messages[0]?.content ?? "");
    assert.match(live, /the window is roomy again/, "precondition: the live notice carries the usage line");
    const events = await readEvents(`${sd}/chat.jsonl`);
    const comp = events.filter((e) => e.type === "compaction").at(-1);
    assert.ok(comp, "precondition: the compaction is logged");
    assert.equal(dataOf(comp).mode, "summarize", "precondition: this compaction summarized (not truncate)");
    assert.match(String(dataOf(comp).contextLine ?? ""), /% used/, "the line is recorded with the compaction");
    await a.dispose();

    // restart: the same session dir, a fresh agent
    const b = make();
    await b.init();
    await b.load();
    const restored = String((b as unknown as { messages: { content?: string }[] }).messages[0]?.content ?? "");
    if (restored !== live) {
      const i = [...live].findIndex((ch, k) => ch !== restored[k]);
      console.error("[dbg] live len", live.length, "restored len", restored.length, "first diff at", i);
      console.error("[dbg] live    :", JSON.stringify(live.slice(Math.max(0, i - 40), i + 120)));
      console.error("[dbg] restored:", JSON.stringify(restored.slice(Math.max(0, i - 40), i + 120)));
    }
    assert.equal(
      restored,
      live,
      "the restored notice must be identical — a different byte at the front of the conversation costs the prefix cache",
    );
    await b.dispose();
  });
});
