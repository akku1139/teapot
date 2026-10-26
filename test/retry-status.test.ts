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
      const log = (a as unknown as {
        log: { append: (type: string, s: string, b: string, d: unknown) => Promise<unknown> };
      }).log;
      const orig = log.append.bind(log);
      let failed = false;
      log.append = async (type, s, b, d) => {
        if (!failed && type === "state" && (d as { detail?: string })?.detail === "llm turn start") {
          failed = true;
          log.append = orig; 
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