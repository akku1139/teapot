/**
 * onError:"retry" の再ラウンドが status="error" のまま走る。
 *
 * ラウンドが致命的エラーで落ちると: setStatus("error", "…retrying in Ns") →
 * 待機 → continue。次ラウンドに入る前に running へ戻す処理が無く、実際に
 * LLM とツールが走っている間も status="error" のまま。isLive() は error を
 * 含まないので live=false（UI が start を出し得る）。
 *
 * Required: retry 後のラウンドは running として実行される。
 *
 * （llmCall 内部リトライは waits=[5s,5s,30s] で現実的でないため、ラウンド級
 * エラーは「llm turn start のログ書込が1回だけ失敗する」ことで誘発する —
 * runTurnsUntilIdle から loop の catch へ伝播し、onError:"retry" 経路に入る。
 * retryDelayMs は 1s に設定済み。）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

test("a retry round runs as 'running', not as 'error' (#C5)", async () => {
  await useTempDirs(["c5a-", "c5b-"], async ([ws, sd]) => {
    let statusAtFirstChatCall = "";
    const a = new Agent({
      id: "c",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => {
        statusAtFirstChatCall = (a as unknown as { status: string }).status;
        return { message: { role: "assistant" as const, content: "recovered" } };
      },
      onError: "retry",
      retryDelayMs: 1_000,
      autoContinue: false,
    } as never) as Agent;
    try {
      await a.init();
      await a.setGoal("g");
      // the round-fatal error: the FIRST "llm turn start" write fails once
      const log = (a as unknown as {
        log: { append: (type: string, s: string, b: string, d: unknown) => Promise<unknown> };
      }).log;
      const orig = log.append.bind(log);
      let failed = false;
      log.append = async (type, s, b, d) => {
        if (!failed && type === "state" && (d as { detail?: string })?.detail === "llm turn start") {
          failed = true;
          log.append = orig; // the retry round writes normally
          throw new Error("simulated log write failure");
        }
        return orig(type, s, b, d);
      };

      a.enqueuePrompt("go", "user");
      a.start("t");
      await a.settled();
      assert.ok(failed, "precondition: the round-fatal write failure happened");
      assert.equal(
        statusAtFirstChatCall,
        "running",
        `the retry round must execute as running (got "${statusAtFirstChatCall}")`,
      );
      assert.equal(a.status, "idle", "and settles idle after recovery");
    } finally {
      a.stop("end");
      await a.settled().catch(() => {});
      await a.dispose().catch(() => {});
    }
  });
});