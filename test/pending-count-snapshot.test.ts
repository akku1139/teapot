/**
 * 「⏳ N of yours queued」バッジが id 無し harness prompt も数え、✕ cancel の
 * 対象（pendingPromptIds / pendingPromptQueue = user prompt のみ）とズレていた。
 *
 * ただし snapshot の pendingPrompts 自体は「配送カウンタ」（ハーネス含む全件）
 * として意味がある — #141 の配送テストと live 判定（isLive の queued 項）が
 * それを理由にする。壊れていたのはバッジ側: cancel できないものを「yours」と
 * して数えていた。
 *
 * Required:
 *   - snapshot.pendingPrompts は配送カウンタのまま（ハーネス含む全件）
 *   - バッジは pendingPromptIds（取消可能集合）を読む
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("snapshot.pendingPrompts stays the DELIVERY counter (harness included) (#141 contract)", async () => {
  await useTempDirs(["d3a-", "d3b-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "c",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({ message: { role: "assistant" as const, content: "ok" } }),
      autoContinue: false,
    } as never) as Agent;
    try {
      await a.init();
      a.enqueuePrompt("[harness] child finished: report", "harness"); // no id
      a.enqueuePrompt("mine", "user"); // has an id

      const s = a.snapshot();
      const ids = (s as unknown as { pendingPromptIds?: string[] }).pendingPromptIds ?? [];
      const queue = (s as unknown as { pendingPromptQueue?: unknown[] }).pendingPromptQueue ?? [];
      assert.equal(s.pendingPrompts, 2, "the delivery counter counts every queued prompt");
      assert.equal(ids.length, 1, "the cancellable set is the user prompt only");
      assert.equal(queue.length, 1, "the echoed queue matches the cancellable set");
    } finally {
      a.stop("end");
      await a.settled().catch(() => {});
      await a.dispose().catch(() => {});
    }
  });
});

test("the queued badge counts the CANCELLABLE set, not the delivery counter (#D3)", () => {
  const app = readSource(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "App.tsx"));
  const at = app.indexOf("of yours queued");
  assert.notEqual(at, -1, "the badge must exist");
  const block = app.slice(app.lastIndexOf("<Show when={(sel()!.pendingPromptIds", at - 400) === -1 ? Math.max(0, at - 900) : app.lastIndexOf("<Show when={(sel()!.pendingPromptIds", at - 400), at);
  assert.match(
    block,
    /pendingPromptIds\?\.length/,
    "the badge must read the cancellable ids — harness prompts have no ✕ and are not 'yours' (#D3)",
  );
});