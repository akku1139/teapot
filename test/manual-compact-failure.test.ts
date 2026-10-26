/**
 * compactPhase に finally がなく、compaction 開始ログの書込失敗でリークする。
 *
 * `compactPhase = "summarizing"` を設定した後の `context-compaction-started`
 * append は try の外にあった。EventLog.append はストリームエラー（ディスク
 * 枯渇など）で reject するため、例外が maybeCompact を抜けた瞬間、phase が
 * "summarizing" のまま残る。isLive() は compactPhase を見るので:
 *
 *   status = error / live = true 固定 → UI は stop を出し、押しても効かない
 *
 * #127 が直した「複数箇所の真実の食い違い」が別経路で再発する形。
 *
 * Required: compaction がどのステップで失敗しても compactPhase は空に戻り、
 * isLive() が pin されない。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";

test("a failed compaction leaves NO phase behind (no live pin) (#D2)", async () => {
  await useTempDirs(["d2a-", "d2b-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "c",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({ message: { role: "assistant" as const, content: "unused" } }),
      autoContinue: false,
    } as never) as Agent;
    try {
      await a.init();
      await a.setGoal("g");
      const msgs: { role: "user" | "assistant"; content: string }[] = [];
      for (let i = 0; i < 40; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `msg ${i}` });
      (a as unknown as { messages: unknown[] }).messages = msgs;

      // the disk fills up exactly when the compaction START row is written —
      // later writes must still work so the failure is scoped to this step
      const log = (a as unknown as {
        log: { append: (type: string, session: string, branch: string, data: unknown) => Promise<unknown> };
      }).log;
      const orig = log.append.bind(log);
      log.append = async (type, session, branch, data) => {
        if ((data as { event?: string })?.event === "context-compaction-started")
          throw new Error("ENOSPC: simulated disk full");
        return orig(type, session, branch, data);
      };

      let failure: unknown = null;
      try {
        await a.compactNow();
      } catch (e) {
        failure = e;
      }
      log.append = orig; // restore before teardown
      assert.ok(failure instanceof Error && /ENOSPC/.test(failure.message), "the failure surfaces to the caller");
      assert.equal(
        (a as unknown as { compactPhase: string }).compactPhase,
        "",
        "the phase must not survive a failed compaction (#D2)",
      );
      assert.equal(a.isLive(), false, "no live pin after the failure (#D2)");
    } finally {
      a.stop("end");
      await a.settled().catch(() => {});
      await a.dispose().catch(() => {});
    }
  });
});