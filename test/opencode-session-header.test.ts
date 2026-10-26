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

const GO = "https://opencode.ai/zen/go/v1";

test("providerHeaders: x-opencode-session goes to opencode.ai, and nowhere else", () => {
  assert.deepEqual(providerHeaders(GO, "sess-1"), { "x-opencode-session": "sess-1" });
  assert.deepEqual(providerHeaders("https://OPENCODE.AI/zen/v1", "sess-1"), {
    "x-opencode-session": "sess-1",
  });
  assert.deepEqual(providerHeaders(GO), {});
  assert.deepEqual(providerHeaders(GO, ""), {});
  assert.deepEqual(providerHeaders("https://api.openai.com/v1", "sess-1"), {});
  assert.deepEqual(providerHeaders("https://api.orcarouter.ai/v1", "sess-1"), {});
  assert.deepEqual(providerHeaders("http://localhost:11434/v1", "sess-1"), {});
  assert.deepEqual(providerHeaders("https://opencode.ai.example.com/v1", "sess-1"), {});
  assert.deepEqual(providerHeaders("https://notopencode.ai/v1", "sess-1"), {});
  assert.deepEqual(providerHeaders("https://openrouter.ai/api/v1", "sess-1"), {
    "HTTP-Referer": "https://github.com/akku1139/teapot",
    "X-OpenRouter-Title": "teapot",
    "X-OpenRouter-Categories": "programming-app",
  });
  assert.deepEqual(providerHeaders("not a url", "sess-1"), {});
});

const COMPLETION = {
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

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
  assert.equal(go.authorization, "Bearer k"); 

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

const reply = (content: string): LlmResult => ({ message: { role: "assistant", content } });

test("agent turns, and their summariser, name the conversation's session", async () => {
  const seen: LlmConfig[] = [];
  const chatFn: ChatFn = async (cfg) => {
    seen.push(cfg);
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
      assert.equal(seen[0]!.sessionId, path.basename(sd)); 

      agent.setLlmConfig({ baseUrl: "https://api.openai.com/v1", apiKey: "k2", model: "gpt" });
      agent.enqueuePrompt("again");
      agent.start("test");
      await agent.settled();
      assert.equal(seen.length, 2);
      assert.equal(seen[1]!.sessionId, agent.currentSession);

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
