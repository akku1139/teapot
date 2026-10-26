import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chat, chatStream, type LlmConfig } from "../src/agent/llm.ts";

async function stub(sse: string | Record<string, unknown>) {
  const server: Server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (typeof sse === "string") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(sse));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const cfg = (url: string): LlmConfig => ({ baseUrl: url, apiKey: "k", model: "m", timeoutMs: 5000 });

const frame = (delta: Record<string, unknown>): string =>
  `data: ${JSON.stringify({ choices: [{ delta, index: 0 }] })}\n\n`;

test("the non-streaming path reads `reasoning_content` (#153, commandcode)", async () => {
  const s = await stub({
    choices: [
      {
        message: { role: "assistant", content: "391", reasoning_content: "17*23 = 391" },
        finish_reason: "stop",
      },
    ],
  });
  try {
    const res = await chat(cfg(s.url), [{ role: "user", content: "hi" }], []);
    assert.equal(res.reasoning, "17*23 = 391", "the thinking must survive, not be discarded (#153)");
    assert.equal(res.message.content, "391", "and the answer is unaffected");
  } finally {
    await s.close();
  }
});

test("the streaming path reads `reasoning_content` too (#153)", async () => {
  const s = await stub(
    frame({ role: "assistant", reasoning_content: "step one " }) +
      frame({ reasoning_content: "step two" }) +
      frame({ content: "391" }) +
      "data: [DONE]\n\n",
  );
  try {
    const res = await chatStream(cfg(s.url), [{ role: "user", content: "hi" }], []);
    assert.equal(res.reasoning, "step one step two", `streamed thinking lost (#153): ${res.reasoning}`);
    assert.equal(res.message.content, "391");
  } finally {
    await s.close();
  }
});

test("OpenRouter's `reasoning` keeps working — the field it already used (#153)", async () => {
  const s = await stub(
    frame({ role: "assistant", reasoning: "thinking " }) + frame({ reasoning: "more" }) + frame({ content: "391" }) + "data: [DONE]\n\n",
  );
  try {
    const res = await chatStream(cfg(s.url), [{ role: "user", content: "hi" }], []);
    assert.equal(res.reasoning, "thinking more", "OpenRouter's spelling must still be read (#153)");
  } finally {
    await s.close();
  }
});

test("no reasoning field at all leaves `reasoning` undefined (#153)", async () => {
  const s = await stub(frame({ role: "assistant", content: "391" }) + "data: [DONE]\n\n");
  try {
    const res = await chatStream(cfg(s.url), [{ role: "user", content: "hi" }], []);
    assert.equal(res.reasoning, undefined);
  } finally {
    await s.close();
  }
});
