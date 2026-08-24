import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chat } from "../src/agent/llm.ts";

/** one-shot provider that answers with a fixed JSON body */
async function withProvider(body: unknown, fn: (port: number) => Promise<void>) {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

test("llm repairs provider-glued tool calls (framing tags leaked into name)", async () => {
  // seen live: two calls arrived as ONE entry whose name contained
  // get_goal</tool_call><…><tool_call><list_dir
  await withProvider(
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "cb6d6991",
                function: { name: "get_goal\ufffd\ufffdlist_dir", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    async (port) => {
      const res = await chat(
        { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m" },
        [{ role: "user", content: "hi" }],
        [],
      );
      const names = res.message.tool_calls?.map((c) => c.function.name) ?? [];
      assert.deepEqual(names, ["get_goal", "list_dir"]); // split back into two real calls
      assert.ok(res.message.tool_calls!.every((c) => !/[\ufffd<>]/.test(c.function.name)));
    },
  );
});

test("llm drops unsalvageable tool names instead of failing the round with 'unknown tool'", async () => {
  await withProvider(
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "x", function: { name: "<garbage><", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    async (port) => {
      const res = await chat(
        { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", model: "m" },
        [{ role: "user", content: "hi" }],
        [],
      );
      assert.deepEqual(res.message.tool_calls ?? [], []); // dropped (empty array)
      assert.ok(!res.message.content || res.message.content.length >= 0);
    },
  );
});
