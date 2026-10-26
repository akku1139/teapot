import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

test("recentReads keeps only the files that actually restored (order preserved)", async () => {
  await useTempDirs(["c6a-", "c6b-"], async ([ws, sd]) => {
    mkdirSync(path.join(ws, "docs"), { recursive: true });
    writeFileSync(path.join(ws, "docs", "a.txt"), "alpha");
    writeFileSync(path.join(ws, "docs", "c.txt"), "gamma");

    const a = new Agent({
      id: "c",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({ message: { role: "assistant" as const, content: "compacted summary" } }),
      autoContinue: false,
    } as never) as Agent;
    try {
      await a.init();
      await a.setGoal("g");
      const msgs: { role: "user" | "assistant"; content: string }[] = [];
      for (let i = 0; i < 40; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: `msg ${i}` });
      (a as unknown as { messages: unknown[] }).messages = msgs;
      (a as unknown as { recentReads: string[] }).recentReads = ["docs/a.txt", "docs/b.txt", "docs/c.txt"];

      await a.compactNow();
      assert.deepEqual(
        (a as unknown as { recentReads: string[] }).recentReads,
        ["docs/a.txt", "docs/c.txt"],
        "the vanished file drops; the surviving tail keeps its order",
      );
    } finally {
      rmSync(path.join(ws, "docs"), { recursive: true, force: true });
      a.stop("end");
      await a.settled().catch(() => {});
      await a.dispose().catch(() => {});
    }
  });
});