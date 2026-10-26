import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { useTempDirs } from "./helpers/tmp.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

markPosixOnly("starts a background shell through the bash tool");

const reply = (content: string, calls?: unknown[]): LlmResult => ({
  message: {
    role: "assistant",
    content,
    ...(calls ? { tool_calls: calls as NonNullable<LlmResult["message"]["tool_calls"]> } : {}),
  },
});

const bgCall = (probe: string) => ({
  id: "c1",
  type: "function" as const,
  function: {
    name: "bash",
    arguments: JSON.stringify({ command: `sleep 6; touch ${probe}`, background: true }),
  },
});

async function startBgAgent(ws: string, sd: string, probe: string) {
  let calls = 0;
  const agent = new Agent({
    id: "bg",
    workspace: ws,
    sessionDir: sd,
    llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
    chatFn: async (): Promise<LlmResult> => {
      calls++;
      if (calls === 1) return reply("", [bgCall(probe)]);
      return reply("done");
    },
    autoContinue: true,
    continueDelayMs: 300,
  } as never);
  await agent.init();
  agent.enqueuePrompt("go");
  agent.start("t");
  for (let i = 0; i < 60 && calls < 2; i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  return agent;
}

test("a running BACKGROUND shell makes the agent live — the UI must offer stop (#158)", async () => {
  await useTempDirs(["bg158a-", "bg158b-"], async ([ws, sd]) => {
    const probe = path.join(ws!, "never-touched.txt");
    const agent = await startBgAgent(ws!, sd!, probe);
    try {
      assert.equal(
        agent.status,
        "idle",
        "precondition: the round that started the bg job ENDS, leaving status idle (#158)",
      );
      assert.equal(
        agent.isLive(),
        true,
        "a running background job is work `stop` would stop, so the agent is live (#158) — " +
          "false here is why the UI showed '▶ start' and offered no way to stop it",
      );
    } finally {
      await agent.dispose();
    }
  });
});

test("stop() KILLS a running background shell instead of leaving it behind (#158)", async () => {
  await useTempDirs(["bg158c-", "bg158d-"], async ([ws, sd]) => {
    const probe = path.join(ws!, "touched-after-stop.txt");
    const agent = await startBgAgent(ws!, sd!, probe);
    try {
      agent.stop("stopped via api");
      await Promise.race([agent.settled(), new Promise((r) => setTimeout(r, 4000))]);
      assert.equal(agent.isLive(), false, "after a stop the agent is not live (#133/#158)");
      await new Promise((r) => setTimeout(r, 7_500));
      assert.equal(
        fs.existsSync(probe),
        false,
        "the background job outlived stop() and completed after it (#158) — measured with `sleep 300`",
      );
    } finally {
      await agent.dispose();
    }
  });
});

test("dispose() kills a running background shell too — shutdown must not orphan jobs (#158)", async () => {
  await useTempDirs(["bg158e-", "bg158f-"], async ([ws, sd]) => {
    const probe = path.join(ws!, "touched-after-dispose.txt");
    const agent = await startBgAgent(ws!, sd!, probe);
    await agent.dispose();
    await new Promise((r) => setTimeout(r, 7_500));
    assert.equal(
      fs.existsSync(probe),
      false,
      "a background job survived harness shutdown, still burning CPU with nothing tracking it (#158)",
    );
  });
});
