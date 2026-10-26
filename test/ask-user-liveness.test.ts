import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

test("an agent parked on ask_user is LIVE (stoppable), not idle (#D4)", async () => {
  await useTempDirs(["d4a-", "d4b-"], async ([ws, sd]) => {
    const a = new Agent({
      id: "q",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      chatFn: async () => ({ message: { role: "assistant" as const, content: "x" } }),
      autoContinue: false,
    } as never) as Agent;
    try {
      await a.init();
      (a as unknown as { awaitingUser: boolean }).awaitingUser = true;
      (a as unknown as { status: string }).status = "waiting";
      assert.equal(
        a.isLive(),
        true,
        "an open question is stoppable work — live, not idle (#D4)",
      );
      (a as unknown as { awaitingUser: boolean }).awaitingUser = false;
      assert.equal(a.isLive(), false, "once answered/cleared, the agent is idle again");
    } finally {
      a.stop("end");
      await a.settled().catch(() => {});
      await a.dispose().catch(() => {});
    }
  });
});

test("an agent parked on ask_user counts as ACTIVE for waitChildren (kept)", async () => {
  const dataDir = mkdtempInRootSync("d4c-");
  const { Master } = await import("../src/master.ts");
  const m = new Master({ port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, providers: {}, agents: [] }, `${dataDir}/config.json`);
  const ws = mkdtempInRootSync("d4w-");
  const child = await m.addAgent({ id: "c", parent: "p", workspace: ws, chatFn: async () => ({ message: { role: "assistant" as const, content: "x" } }) }, { persist: false });
  try {
    (child as unknown as { awaitingUser: boolean }).awaitingUser = true;
    (child as unknown as { status: string }).status = "waiting";
    let settled = false;
    const noteP = m.waitChildren("p", ["c"], 5_000).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settled, false, "a question-asking child is still working (pre-existing contract)");
    child.stop("done");
    const r = await Promise.race([noteP, new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 2_000))]);
    assert.notEqual(r, "timeout", "the stop resolves the wait");
  } finally {
    for (const a of [...m.agents.values()]) a.stop("done");
    for (const a of [...m.agents.values()]) await a.settled().catch(() => {});
  }
});
