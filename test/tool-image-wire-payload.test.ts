import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chat } from "../src/agent/llm.ts";
import type { ChatMessage } from "../src/agent/llm.ts";

/**
 * An image-bearing TOOL message must reach the API with its `tool_call_id`.
 *
 * MEASURED on v0.37.69 (`github-bug-research-1f48715f`): `read_file` on a JPEG returned the image, the
 * row rendered "the image itself is attached", and the very next request 400'd with
 * `Invalid input: expected string, received undefined`.
 *
 * Cause: `sanitize()` built `{ role, content }` for a `content_parts` message and dropped everything
 * else. For a tool message the id is not decoration — the API pairs results to calls by it, and the
 * assistant message that made the call was still in the payload.
 *
 * This test drives the REAL `chat()` against a local server, so it fails on the actual bytes instead of
 * on a re-implementation of `sanitize()`.
 */
async function capture(messages: ChatMessage[]): Promise<Record<string, unknown>[]> {
  let body: { messages: Record<string, unknown>[] } | null = null;
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      body = JSON.parse(b);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    await chat(
      { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m" },
      messages,
      [],
    );
  } finally {
    srv.close();
  }
  // `body` is assigned inside the request handler, which TypeScript cannot see, so narrow through a
  // local rather than asserting on the captured variable directly (a non-null assert leaves it `never`)
  const got = body as { messages: Record<string, unknown>[] } | null;
  if (!got) throw new Error("the request must have been made");
  return got.messages;
}

const imageToolMsg = (): ChatMessage[] => [
  {
    role: "assistant",
    content: "reading",
    tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
  },
  {
    role: "tool",
    tool_call_id: "c1",
    content: "card.jpg is a JPEG image",
    content_parts: [
      { type: "text", text: "card.jpg is a JPEG image" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
    ],
  },
];

test("an image tool message keeps its tool_call_id (#images)", async () => {
  const sent = await capture(imageToolMsg());
  const tool = sent.find((m) => m.role === "tool");
  assert.ok(tool, "the tool message must be in the payload");
  assert.equal(tool.tool_call_id, "c1", "without this the request is a 400, not a missing image");
  assert.equal(tool.content instanceof Array, true, "and the image rides in content as parts");
  assert.deepEqual(
    (tool.content as { type: string }[]).map((p) => p.type),
    ["text", "image_url"],
  );
});

test("our internal `content_parts` field never reaches the API (#images)", async () => {
  // a strict server rejects unknown properties; the parts are already in `content`
  const sent = await capture(imageToolMsg());
  for (const m of sent) {
    assert.equal("content_parts" in m, false, `leaked content_parts on ${String(m.role)}`);
  }
});

test("a plain tool message is byte-identical to before (#images)", async () => {
  // the multimodal branch must not change the text path
  const sent = await capture([
    {
      role: "assistant",
      content: "reading",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c1", content: "1| hello" },
  ]);
  const tool = sent.find((m) => m.role === "tool");
  assert.deepEqual(Object.keys(tool!).sort(), ["content", "role", "tool_call_id"]);
  assert.equal(tool!.content, "1| hello");
});
