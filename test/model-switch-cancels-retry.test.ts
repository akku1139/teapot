/**
 * Switching models must cancel the backoff the OLD model earned (#287).
 *
 * "リトライ中にモデルを切り替えたときにはリトライをキャンセルして新しいモデルを適用するように". `llmCall` sleeps between attempts,
 * and the wait comes from the failure of the model being replaced — so a switch changed nothing until that sleep expired,
 * which after six failures is ten minutes of the new model sitting idle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

type Internals = { retrySleeping: boolean; wake: (() => void) | null };

test("setLlmConfig wakes a backoff sleep, and only when one is running", async () => {
  await useTempDirs(["msc-a-", "msc-b-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "msc",
      workspace: ws!,
      sessionDir: sd!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "old" } as never,
      chatFn: async () => ({ content: "", toolCalls: [] }) as never,
    });
    const it = a as unknown as Internals;

    let woken = 0;
    it.wake = () => {
      woken++;
    };

    it.retrySleeping = false;
    a.setLlmConfig({ baseUrl: "http://x", apiKey: "k", model: "new" } as never);
    assert.equal(woken, 0, "no backoff is running, so there is nothing to cancel");
    assert.equal(a.llm.model, "new", "the config is applied either way");

    it.retrySleeping = true;
    a.setLlmConfig({ baseUrl: "http://x", apiKey: "k", model: "newer" } as never);
    assert.equal(woken, 1, "the backoff must end so the next attempt uses the new model");
    assert.equal(a.llm.model, "newer");

    await (a as unknown as { log?: { close(): Promise<void> } }).log?.close?.();
  });
});
