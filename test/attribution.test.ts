import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { providerHeaders, chat, type LlmConfig } from "../src/agent/llm.ts";

const ATTRIBUTION = {
  "HTTP-Referer": "https://github.com/akku1139/teapot",
  "X-OpenRouter-Title": "teapot",
  "X-OpenRouter-Categories": "programming-app",
};

test("providerHeaders: attribution only for openrouter.ai hosts", () => {
  assert.deepEqual(providerHeaders("https://openrouter.ai/api/v1"), ATTRIBUTION);
  assert.deepEqual(providerHeaders("https://OPENROUTER.AI/api/v1"), ATTRIBUTION);
  assert.deepEqual(providerHeaders("https://evil-openrouter.ai.example.com/v1"), {});
  assert.deepEqual(providerHeaders("https://notopenrouter.ai/v1"), {});
  assert.deepEqual(providerHeaders("https://api.openai.com/v1"), {});
  assert.deepEqual(providerHeaders("https://api.orcarouter.ai/v1"), {});
  assert.deepEqual(providerHeaders("http://localhost:11434/v1"), {});
  assert.deepEqual(providerHeaders("not a url"), {});
});

async function withCaptureServer(
  fn: (url: string, headers: Promise<Record<string, string | undefined>>) => Promise<void>,
): Promise<void> {
  let resolveHeaders: (h: Record<string, string | undefined>) => void;
  const headers = new Promise<Record<string, string | undefined>>((res) => {
    resolveHeaders = res;
  });
  const server = http.createServer((req, res) => {
    resolveHeaders(req.headers as Record<string, string | undefined>);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  try {
    const port = (server.address() as { port: number }).port;
    await fn(`http://127.0.0.1:${port}/v1`, headers);
  } finally {
    server.close();
  }
}

const CFG: Omit<LlmConfig, "baseUrl"> = { apiKey: "k", model: "m" };

test("chat(): non-openrouter base URLs send NO attribution headers", async () => {
  await withCaptureServer(async (baseUrl, headers) => {
    await chat({ ...CFG, baseUrl }, [{ role: "user", content: "hi" }], []);
    const h = await headers;
    assert.equal(h["HTTP-Referer"], undefined);
    assert.equal(h["x-openrouter-title"], undefined);
    assert.equal(h.authorization, "Bearer k"); 
  });
});

