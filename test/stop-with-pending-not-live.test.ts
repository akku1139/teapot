import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/agent.ts";

import { mkdtempInRootSync } from "./helpers/tmp-root.ts";

const _here = path.dirname(fileURLToPath(import.meta.url));

async function stopWithPending() {
  const ws = mkdtempInRootSync("t133w-");
  const sd = mkdtempInRootSync("t133s-");
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let n = 0;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      n++;
      if (n <= 1) await gate;
      return { message: { role: "assistant" as const, content: "ok" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  a.enqueuePrompt("first", "user");
  a.start("t");
  await new Promise((r) => setTimeout(r, 150));
  a.enqueuePrompt("queued behind", "user"); 
  const before = a.snapshot();
  a.stop("user pressed stop");
  release();
  await new Promise((r) => setTimeout(r, 600));
  return { a, before, after: a.snapshot() };
}

test("a stop with prompts queued is NOT live (#133)", async () => {
  const { before, after } = await stopWithPending();
  assert.equal(before.live, true, "precondition: live while working (#133)");
  assert.equal(after.status, "stopped", "precondition: the stop took (#133)");
  assert.equal(
    after.live,
    false,
    `a stopped agent must not read live (#133); live=${after.live} pending=${after.pendingPrompts}`,
  );
});

test("the queued prompts are KEPT, not discarded (#9, #133)", async () => {
  const { after } = await stopWithPending();
  assert.equal(after.pendingPrompts, 1, "the queued prompt survives the stop (#9)");
});

test("a start consumes the queued prompt and goes live again (#133)", async () => {
  const ws = mkdtempInRootSync("t133x-");
  const sd = mkdtempInRootSync("t133y-");
  let calls = 0;
  const a = new Agent({
    id: "t",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async () => {
      calls++;
      return { message: { role: "assistant" as const, content: "ok" } };
    },
    autoContinue: false,
  } as never) as Agent;
  await a.init();
  await a.setGoal("g");
  a.enqueuePrompt("first", "user");
  a.start("t");
  await a.settled();
  assert.equal(calls, 1, "precondition: one turn ran (#133)");
  a.enqueuePrompt("queued while stopped", "user");
  a.stop("stop");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(a.snapshot().live, false, "precondition: stopped and not live (#133)");
  assert.equal(a.snapshot().pendingPrompts, 1, "precondition: it is still queued (#133)");
  try {
    a.start("user pressed start");
    await a.settled();
    assert.equal(calls, 2, "start must run the queued prompt (#133)");
    assert.equal(a.snapshot().pendingPrompts, 0, "and drain the queue (#133)");
  } finally {
    a.stop("done");
    await a.settled().catch(() => {});
  }
});

