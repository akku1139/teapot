/**
 * コスト二重計上 — 再起動後の初回操作で右パネルの costUsd が約 2 倍になる。
 *
 * 同じ chat.jsonl の usage イベントからコストを計算する経路が二つある:
 *
 *   setModelPricing → ログ全体から「置換」で再計算 (stats.costUsd = 合計)
 *   restoreFromLog  → 初回操作で遅延実行され、同じ usage を「加算」
 *
 * 本番の再起動フローでは: 新プロセスの boot で addAgent → fetchModelList 経由で
 * setModelPricing が走り、前プロセスの usage から costUsd を積む。その後の
 * 初回操作 (ensureReady → restoreFromLog) が同じ usage を「加算」するので
 * 2 倍になる。restore 側の加算はどの順序でも不要（価格が後から来ても
 * setModelPricing が置換で上書きする）。
 *
 * Required: 「boot で価格解決 → 初回操作で restore」の順でも costUsd が
 * 1 回分であること。トークン集計は復元される（初回プロセスでは virgin stats
 * への加算なので。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

const PRICING = { prompt: 0.001, completion: 0.002 };
const chatFn = async () => ({
  message: { role: "assistant" as const, content: "reply" },
  usage: { inputTokens: 1000, outputTokens: 500 },
});

/** one turn を記録しただけの agent を作って走らせる */
async function runOneTurn(ws: string, sd: string): Promise<Agent> {
  const a = new Agent({
    id: "c",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn,
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  a.enqueuePrompt("go", "user");
  a.start("t");
  await a.settled();
  await new Promise((r) => setTimeout(r, 150));
  return a;
}

test("restart + pricing-first + first interaction must NOT double the cost", async () => {
  await useTempDirs(["cost1-", "cost2-"], async ([ws, sd]) => {
    // process 1: one turn (usage lands in the log), then it dies
    const first = await runOneTurn(ws, sd);
    await first.dispose();

    // process 2: a NEW Agent instance on the SAME session dir — boot resolves
    // pricing from the log, then the operator's first click restores the session
    const a = new Agent({
      id: "c",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn,
      autoContinue: false,
    } as never) as Agent;
    try {
      await a.init();
      // BOOT: pricing resolves (the fetch raced and won) — recompute replaces
      await a.setModelPricing(PRICING);
      const afterPricing = a.snapshot().stats.costUsd ?? 0;
      assert.equal(afterPricing, 1000 * 0.001 + 500 * 0.002, "the recompute priced the previous session");

      // FIRST INTERACTION: ensureReady → restoreFromLog
      await (a as unknown as { restoreFromLog(): Promise<void> }).restoreFromLog();
      assert.equal(
        a.snapshot().stats.costUsd ?? 0,
        afterPricing,
        "restore must not re-add the cost the recompute already built (2x bug)",
      );
      // token totals ARE restored additively (virgin stats in a fresh process)
      assert.equal(a.snapshot().stats.inputTokens, 1000, "token totals survive the restore");
    } finally {
      a.stop("end");
      await a.settled().catch(() => {});
      await a.dispose().catch(() => {});
    }
  });
});

test("pricing arriving AFTER the restore still lands the full number (replacement path)", async () => {
  await useTempDirs(["cost3-", "cost4-"], async ([ws, sd]) => {
    const a = await runOneTurn(ws, sd);
    try {
      // restore FIRST (pricing unknown — no cost add), pricing LATER
      await (a as unknown as { restoreFromLog(): Promise<void> }).restoreFromLog();
      await a.setModelPricing(PRICING);
      assert.equal(
        a.snapshot().stats.costUsd ?? 0,
        1000 * 0.001 + 500 * 0.002,
        "the late pricing recompute replaces, never adds",
      );
    } finally {
      a.stop("end");
      await a.settled().catch(() => {});
      await a.dispose().catch(() => {});
    }
  });
});
