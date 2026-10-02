/**
 * #59 — "can't stop a session when a goal is active?"
 *
 * The ⏯ control is one button that reads either "▶ start" or "■ stop", and it
 * chose between them with a single field:
 *
 *     sel()!.status === "running"
 *
 * That is not a safe proxy for "is there work in flight". `status` reports what
 * the operator should SEE, and a long-parking tool deliberately makes that
 * "idle" so a multi-minute `wait_children` is not a running spinner:
 *
 *     parkForTool() { ... this.status = "idle"; ... }   // loop still alive
 *
 * So an agent parked in `wait_children` — which is exactly what happens once it
 * has spawned sub-agents and is waiting on them, i.e. with a goal in flight —
 * offered **start** rather than stop. The user pressed stop and the agent
 * started. Pressing it again called `/start` again. There was no stop button.
 *
 * The same wrong field drove the Escape interrupt, so Esc did nothing on a
 * working agent either, and the tab title's ▶ indicator went missing.
 *
 * The client cannot derive this: `parkedByTool` was never sent. The server
 * knows, so the server now says (`Agent.live`) and the UI trusts that.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const agentSrc = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");

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

/* ---------- the rule ---------- */

test("a parked agent is LIVE even though its status reads idle (#59)", async () => {
  await useTempDirs(["p59a-", "p59b-"], async ([ws, sessionDir]) => {
    // wait_children parks the agent inside the tool: status goes "idle" while
    // the loop is very much alive, which is the state the report describes.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    let parkedSeen = false;
    const chatFn = async (_c: unknown, messages: any): Promise<LlmResult> => {
      if (!parkedSeen) {
        parkedSeen = true;
        // wait_children with no ids parks until woken; poll until the agent has
        // actually flipped to idle, then observe
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
        // THE BUG: status says idle, so the UI offered "start" and the user
        // could not stop it
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
  // A stopped agent accepts prompts and holds them. A later start() consumes
  // them, so there is pending work and the user must be able to withdraw it.
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
      true,
      "held prompts are pending work — the user must be able to stop/clear (#59)",
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

/* ---------- wiring: the UI must trust the server ---------- */

test("the ⏯ button decides on `live`, not on status (#59)", () => {
  assert.match(
    app,
    /onclick=\{isSelLive\(\) \? act\("\/stop"\) : act\("\/start"\)\}/,
    "the control must offer stop whenever the agent is live (#59)",
  );
  assert.doesNotMatch(
    app,
    /onclick=\{sel\(\)!\.status === "running" \? act\("\/stop"\) : act\("\/start"\)\}/,
    "the status-only check is the regression (#59)",
  );
});

test("Escape interrupts on `live` too (#59)", () => {
  // Same wrong field: Esc did nothing at all on a parked agent, which is
  // precisely when a user reaches for it.
  assert.match(app, /if \(s && isSelLive\(\)\) \{[\s\S]{0,160}\/stop/, "Esc must stop a parked agent (#59)");
});

test("the fallback covers an older server that does not send `live` (#59)", () => {
  // `??` rather than a bare read, so a cached snapshot from a previous server
  // cannot make the button permanently read "start".
  assert.match(
    app,
    /return a\.live \?\? \(a\.status === "running" \|\| a\.status === "waiting"\);/,
    "an older server's snapshot must still drive the button (#59)",
  );
});

test("isLive() is the single source of truth on the agent (#59)", () => {
  assert.match(
    agentSrc,
    /isLive\(\): boolean \{\s*return this\.status === "running" \|\| this\.parkedByTool \|\| this\.pendingPrompts\.length > 0;/,
    "live must cover all three states: running, parked, queued (#59)",
  );
});
