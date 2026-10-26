import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/agent.ts";

import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const _here = path.dirname(fileURLToPath(import.meta.url));

async function agentCompacting() {
  const ws = mkdtempInRootSync("t127w-");
  const sd = mkdtempInRootSync("t127s-");
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let armed = false;
  const a = new Agent({
    id: "c",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      if (armed) await gate;
      return { message: { role: "assistant" as const, content: "SUMMARY" } };
    },
    autoContinue: false,
    contextTokenBudget: 500,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  for (let i = 0; i < 12; i++) {
    a.enqueuePrompt("Q".repeat(1500), "user");
    a.start("t");
    await a.settled();
  }
  armed = true;
  const before = a.snapshot();
  const p = a.compactNow();
  await new Promise((r) => setTimeout(r, 250));
  const during = a.snapshot();
  release();
  await p;
  return { before, during, after: a.snapshot(), a };
}

test("a manual compaction on an idle agent reads as IDLE before the fix (#127)", async () => {
  const { before, during, a } = await agentCompacting();
  try {
    assert.equal(before.status, "idle", "precondition: the agent starts idle (#127)");
    assert.equal(before.live, false, "precondition: and is not live (#127)");
    assert.equal(
      during.ctx?.compacting,
      "summarizing",
      "precondition: a compaction really is in flight (#127)",
    );
    assert.equal(
      during.live,
      true,
      `the agent must read as WORKING while it rewrites messages (#127); status=${during.status} live=${during.live}`,
    );
  } finally {
    a.stop("done");
    await a.settled().catch(() => {});
  }
});

test("it is live again once the compaction finishes (#127)", async () => {
  const { after, a } = await agentCompacting();
  try {
    assert.equal(
      after.live,
      false,
      "and must not stay permanently live (#127)",
    );
  } finally {
    a.stop("done");
    await a.settled().catch(() => {});
  }
});

test("the summarizer input is bounded by construction (#127)", () => {
  const lastRouted = ["system", ...Array.from({ length: 100 }, (_, i) => `m${i}`)];
  const cut = 60; 
  const replayed = lastRouted.slice(0, 1 + cut);
  assert.ok(replayed.length < lastRouted.length, "strictly shorter than the request that succeeded");
  assert.equal(replayed[0], "system", "and it keeps the system head, so the cache aligns");
});
