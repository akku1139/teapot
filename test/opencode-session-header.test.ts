/**
 * OpenCode Go refuses a request that arrives without a session id:
 *
 *   "Request is missing x-opencode-session and cannot be routed efficiently"
 *
 * (HTTP 400 — https://opencode.ai/docs/go/#where-can-i-use-it), so every turn
 * teapot sends there must name the conversation it belongs to.
 *
 * Covered, in the order a request travels:
 * 1. providerHeaders() — the pure decision: opencode.ai only, an id is required
 *    before anything is sent, and nothing leaks into another provider's request;
 * 2. the request the real OpenAI SDK builds — a stubbed global fetch shows the
 *    header on the wire, and shows that none is invented when there is no session;
 * 3. an agent turn and its compaction summariser — the config that leaves the
 *    agent carries ITS conversation's session id, including after a mid-session
 *    model switch, which replaces the whole llm config;
 * 4. the setup wizard preset, pinned to the base URL the docs publish.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  chat,
  providerHeaders,
  type ChatFn,
  type LlmConfig,
  type LlmResult,
} from "../src/agent/llm.ts";
import { Agent } from "../src/agent/agent.ts";
import { useTempDirs } from "./helpers/tmp.ts";
import { readSourceUrl } from "./helpers/source.ts";

const GO = "https://opencode.ai/zen/go/v1";

/* ---------- 1. the pure decision ---------- */

test("providerHeaders: x-opencode-session goes to opencode.ai, and nowhere else", () => {
  assert.deepEqual(providerHeaders(GO, "sess-1"), { "x-opencode-session": "sess-1" });
  // Zen (not Go) is the same host: case-insensitive, path/port-insensitive
  assert.deepEqual(providerHeaders("https://OPENCODE.AI/zen/v1", "sess-1"), {
    "x-opencode-session": "sess-1",
  });
  // no id yet → no header. An invented one would be worse than none: it would
  // split one conversation across several routing/cache buckets.
  assert.deepEqual(providerHeaders(GO), {});
  assert.deepEqual(providerHeaders(GO, ""), {});
  // another provider never learns the session id
  assert.deepEqual(providerHeaders("https://api.openai.com/v1", "sess-1"), {});
  assert.deepEqual(providerHeaders("https://api.orcarouter.ai/v1", "sess-1"), {});
  assert.deepEqual(providerHeaders("http://localhost:11434/v1", "sess-1"), {});
  // look-alike hosts must NOT match (anchored regex)
  assert.deepEqual(providerHeaders("https://opencode.ai.example.com/v1", "sess-1"), {});
  assert.deepEqual(providerHeaders("https://notopencode.ai/v1", "sess-1"), {});
  // OpenRouter keeps exactly its attribution headers
  assert.deepEqual(providerHeaders("https://openrouter.ai/api/v1", "sess-1"), {
    "HTTP-Referer": "https://github.com/akku1139/teapot",
    "X-OpenRouter-Title": "teapot",
    "X-OpenRouter-Categories": "programming-app",
  });
  // unparseable input never throws
  assert.deepEqual(providerHeaders("not a url", "sess-1"), {});
});

/* ---------- 2. what actually leaves the process ---------- */

const COMPLETION = {
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

/** one real chat() call with the SDK's fetch stubbed: the headers the provider
 *  would have received. The client is built per call, so the stub is picked up. */
async function wireHeaders(cfg: LlmConfig): Promise<Record<string, string>> {
  const real = globalThis.fetch;
  let sent: Record<string, string> = {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent = Object.fromEntries(new Headers(init?.headers).entries());
    return new Response(JSON.stringify(COMPLETION), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await chat(cfg, [{ role: "user", content: "hi" }], []);
  } finally {
    globalThis.fetch = real;
  }
  return sent;
}

test("chat(): the session id is on the wire for opencode.ai, and only there", async () => {
  const go = await wireHeaders({ baseUrl: GO, apiKey: "k", model: "glm-5.3", sessionId: "sess-42" });
  assert.equal(go["x-opencode-session"], "sess-42");
  assert.equal(go.authorization, "Bearer k"); // sanity: this IS the real request path

  const bare = await wireHeaders({ baseUrl: GO, apiKey: "k", model: "glm-5.3" });
  assert.equal(bare["x-opencode-session"], undefined, "no session id must never be invented");

  const other = await wireHeaders({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "k",
    model: "gpt",
    sessionId: "sess-42",
  });
  assert.equal(other["x-opencode-session"], undefined, "the id must not follow the operator");
});

/* ---------- 3. the agent's own request config ---------- */

const reply = (content: string): LlmResult => ({ message: { role: "assistant", content } });

test("agent turns, and their summariser, name the conversation's session", async () => {
  const seen: LlmConfig[] = [];
  const chatFn: ChatFn = async (cfg) => {
    seen.push(cfg);
    // first call is the turn's answer; later calls include the summariser
    return reply(seen.length === 1 ? "done" : "compacted summary");
  };
  await useTempDirs(["tpsess-ws-", "tpsess-dir-"], async ([ws, sd]) => {
    const agent = new Agent({
      id: "t",
      workspace: ws,
      sessionDir: sd,
      llm: { baseUrl: GO, apiKey: "k", model: "glm-5.3" },
      chatFn,
      autoContinue: false,
    });
    try {
      await agent.init();
      agent.enqueuePrompt("go");
      agent.start("test");
      await agent.settled();

      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.sessionId, agent.currentSession);
      assert.equal(seen[0]!.sessionId, path.basename(sd)); // the session dir IS the conversation

      // a mid-session model switch replaces the whole llm config (master's
      // setAgentModel does exactly this) — the session must survive it
      agent.setLlmConfig({ baseUrl: "https://api.openai.com/v1", apiKey: "k2", model: "gpt" });
      agent.enqueuePrompt("again");
      agent.start("test");
      await agent.settled();
      assert.equal(seen.length, 2);
      assert.equal(seen[1]!.sessionId, agent.currentSession);

      // the summariser is a one-off prompt but the SAME conversation
      const compact = await agent.compactNow();
      assert.equal(compact.ran, true);
      const summarizer = seen.at(-1)!;
      assert.equal(summarizer.oneOff, true, "the last call must be the summariser");
      assert.equal(summarizer.sessionId, agent.currentSession);
    } finally {
      await agent.dispose();
    }
  });
});

/* ---------- 4. the wizard offers the endpoint ---------- */

test("the setup wizard offers OpenCode Go at the documented base URL", () => {
  const app = readSourceUrl(new URL("../frontend/App.tsx", import.meta.url));
  const at = app.indexOf('key: "opencode-go"');
  assert.notEqual(at, -1, "the OpenCode Go preset must exist");
  const entry = app.slice(at, app.indexOf("},", at));
  assert.match(
    entry,
    /url: "https:\/\/opencode\.ai\/zen\/go\/v1"/,
    "the Go base URL is the one the docs publish",
  );
  assert.match(entry, /model: ""/, "the operator still picks a model from the fetched catalogue (#144)");
});
