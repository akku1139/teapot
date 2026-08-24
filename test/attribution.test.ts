/**
 * OpenRouter app-attribution (https://openrouter.ai/docs/app-attribution):
 * requests to openrouter.ai endpoints must carry HTTP-Referer (+ title /
 * categories), while every other provider must stay header-clean.
 *
 * Covered:
 * 1. providerHeaders() — pure decision function (host matching, values);
 * 2. wiring through the real OpenAI SDK client — chat() against a local
 *    capture server proves headers flow (or deliberately don't);
 * 3. a source-level tripwire: if someone removes providerHeaders() from
 *    llm.ts's client(), this fails even though 2 can't hit the real host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { providerHeaders, chat, type LlmConfig } from "../src/agent/llm.ts";

const ATTRIBUTION = {
  "HTTP-Referer": "https://github.com/akku1139/teapot",
  "X-OpenRouter-Title": "teapot",
  "X-OpenRouter-Categories": "programming-app",
};

test("providerHeaders: attribution only for openrouter.ai hosts", () => {
  assert.deepEqual(providerHeaders("https://openrouter.ai/api/v1"), ATTRIBUTION);
  // case-insensitive + subdomain-friendly, path/port-insensitive
  assert.deepEqual(providerHeaders("https://OPENROUTER.AI/api/v1"), ATTRIBUTION);
  // look-alike hosts must NOT match (anchored regex)
  assert.deepEqual(providerHeaders("https://evil-openrouter.ai.example.com/v1"), {});
  assert.deepEqual(providerHeaders("https://notopenrouter.ai/v1"), {});
  // every other provider stays untouched
  assert.deepEqual(providerHeaders("https://api.openai.com/v1"), {});
  assert.deepEqual(providerHeaders("https://api.orcarouter.ai/v1"), {});
  assert.deepEqual(providerHeaders("http://localhost:11434/v1"), {});
  // unparseable input never throws
  assert.deepEqual(providerHeaders("not a url"), {});
});

/** one-shot local HTTP server capturing request headers, answering an OpenAI-shaped completion */
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
    assert.equal(h.authorization, "Bearer k"); // sanity: our capture is real
  });
});

// The SDK path against the REAL openrouter.ai host can't be integration-tested
// offline — so guard the single wiring line explicitly. If it regresses, the
// unit tests above still pass but live requests would lose attribution.
test("llm.ts wires providerHeaders into the OpenAI client", () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "agent", "llm.ts"),
    "utf8",
  );
  assert.match(src, /defaultHeaders:\s*providerHeaders\(cfg\.baseUrl\)/);
});
