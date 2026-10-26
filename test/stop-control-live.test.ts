import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { readSourceUrl } from "./helpers/source.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const reply = (content: string, calls?: any[]): LlmResult => ({
  message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
});

function mkAgent(ws: string, sessionDir: string, chatFn: any): Agent {
  return new Agent({
    id: "t",
    workspace: ws,
    sessionDir,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
    chatFn,
    autoContinue: false,
  } as any);
}

test("a parked agent is LIVE even though its status reads idle (#59)", async () => {
  await useTempDirs(["p59a-", "p59b-"], async ([ws, sessionDir]) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    let parkedSeen = false;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      if (!parkedSeen) {
        parkedSeen = true;
        for (let i = 0; i < 200 && (agent as any).status !== "idle"; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        assert.equal(
          (agent as any).status,
          "idle",
          "precondition: wait_children must park the agent to 'idle' (#59)",
        );
        assert.equal(
          (agent as any).parkedByTool,
          true,
          "precondition: the agent is parked in a tool, not finished (#59)",
        );
        assert.equal(
          (agent as any).isLive(),
          true,
          "a parked agent must report live, or there is no stop button (#59)",
        );
        release!();
      }
      await gate;
      return reply("done");
    };
    const agent = mkAgent(ws!, sessionDir!, chatFn);
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await new Promise((r) => setTimeout(r, 300));
    release!();
    await agent.settled().catch(() => {});
    await agent.dispose();
  });
});

test("queued prompts make a STOPPED agent live (#59)", async () => {
  await useTempDirs(["p59c-", "p59d-"], async ([ws, sessionDir]) => {
    const agent = mkAgent(ws!, sessionDir!, async () => reply("ok"));
    await agent.init();
    assert.equal(agent.isLive(), false, "a fresh agent is not live (#59)");
    agent.stop("test");
    agent.enqueuePrompt("queued while stopped");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      (agent as any).pendingPrompts.length,
      1,
      "the prompt is held, not delivered (#59)",
    );
    assert.equal(
      agent.isLive(),
      false,
      "a stopped agent is not live, whatever it is holding (#133) — the toggle must offer start",
    );
    await agent.dispose();
  });
});

test("a finished agent is not live (#59)", async () => {
  await useTempDirs(["p59e-", "p59f-"], async ([ws, sessionDir]) => {
    const agent = mkAgent(ws!, sessionDir!, async () => reply("done"));
    await agent.init();
    agent.enqueuePrompt("go");
    agent.start("t");
    await agent.settled();
    assert.equal(agent.isLive(), false, "a settled agent is not live (#59)");
    await agent.dispose();
  });
});

test("the snapshot ships `live` so the client can decide (#59)", async () => {
  await useTempDirs(["p59g-", "p59h-"], async ([ws, sessionDir]) => {
    const agent = mkAgent(ws!, sessionDir!, async () => reply("ok"));
    await agent.init();
    const snap = agent.snapshot() as unknown as { live: boolean; status: string };
    assert.equal(
      typeof snap.live,
      "boolean",
      "the client cannot derive this — parkedByTool was never sent (#59)",
    );
    assert.equal(snap.live, false);
    await agent.dispose();
  });
});

