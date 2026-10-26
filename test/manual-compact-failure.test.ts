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
      log.append = orig; 
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