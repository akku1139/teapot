/**
 * #150 — choosing a reasoning level must never COST a turn.
 *
 * The design decision, and why it is tested end to end rather than by predicate:
 * the endpoints that need this control publish no capability list (measured:
 * commandcode and google return only id/name/context_length), so the field is sent
 * optimistically and dropped with ONE retry if the endpoint refuses it. The
 * predicate tests live in reasoning-effort-providers.test.ts; this file drives the
 * real `chat()` against a stub endpoint, because "the retry recovers" is a claim
 * about the request path, not about a regex.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chat, type LlmConfig } from "../src/agent/llm.ts";

/** a stub OpenAI-compatible endpoint; records every body it receives */
async function stub(reply: (body: Record<string, unknown>, n: number) => { status: number; json: unknown }) {
  const seen: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      seen.push(body);
      const { status, json } = reply(body, seen.length);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    seen,
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const OK = {
  choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

/** the verbatim refusal from the live Google endpoint */
const GOOGLE_REFUSAL = {
  error: {
    code: 400,
    message: "Thinking level is not supported for this model.",
    status: "INVALID_ARGUMENT",
  },
};

test("an endpoint that refuses reasoning_effort is retried without it (#150)", async () => {
  const s = await stub((body) =>
    "reasoning_effort" in body ? { status: 400, json: GOOGLE_REFUSAL } : { status: 200, json: OK },
  );
  try {
    const cfg: LlmConfig = {
      baseUrl: s.url,
      apiKey: "k",
      model: "m",
      reasoningEffort: "high",
      timeoutMs: 5000,
    };
    const res = await chat(cfg, [{ role: "user", content: "hi" }], []);
    assert.equal(res.message.content, "done", "the turn must SUCCEED, not surface the 400 (#150)");
    assert.equal(s.seen.length, 2, `exactly one retry: ${s.seen.length} requests`);
    assert.equal(s.seen[0]!.reasoning_effort, "high", "the first attempt carried the operator's choice");
    assert.equal("reasoning_effort" in s.seen[1]!, false, "and the retry dropped it");
  } finally {
    await s.close();
  }
});

test("an endpoint that ACCEPTS the field is not retried (no wasted call)", async () => {
  const s = await stub(() => ({ status: 200, json: OK }));
  try {
    const res = await chat(
      { baseUrl: s.url, apiKey: "k", model: "m", reasoningEffort: "high", timeoutMs: 5000 },
      [{ role: "user", content: "hi" }],
      [],
    );
    assert.equal(res.message.content, "done");
    assert.equal(s.seen.length, 1, "a working endpoint must be called once");
    assert.equal(s.seen[0]!.reasoning_effort, "high");
  } finally {
    await s.close();
  }
});

test("an UNRELATED 400 is surfaced, not masked by a needless retry (#150)", async () => {
  // the failure mode of a sloppy matcher: a real error (bad key, bad model) gets
  // retried without the field, the operator's choice vanishes, and the message
  // they see is about the retry rather than the actual problem
  const s = await stub(() => ({ status: 400, json: { error: { message: "invalid api key" } } }));
  try {
    await assert.rejects(
      () => chat({ baseUrl: s.url, apiKey: "k", model: "m", reasoningEffort: "high", timeoutMs: 5000 }, [{ role: "user", content: "hi" }], []),
      /invalid api key/,
      "the real error must reach the caller",
    );
    assert.equal(s.seen.length, 1, "and no retry should have been attempted");
  } finally {
    await s.close();
  }
});
