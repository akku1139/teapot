import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { chat, chatStream, type ChatMessage, type LlmConfig } from "../src/agent/llm.ts";
import { isContextOverflow } from "../src/agent/tools.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("runs POSIX commands through the bash tool");

const cfg = (baseUrl: string): LlmConfig => ({ baseUrl, apiKey: "k", model: "m" } as any);
const MSGS: ChatMessage[] = [{ role: "user", content: "hi" }];

async function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  call: (url: string) => Promise<unknown>,
): Promise<{ error: Error | null; shapes: (boolean | null)[] }> {
  const shapes: (boolean | null)[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        shapes.push(JSON.parse(body || "{}").stream === true);
      } catch {
        shapes.push(null);
      }
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  let error: Error | null = null;
  try {
    await call(`http://127.0.0.1:${port}/v1`);
  } catch (e) {
    error = e as Error;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  return { error, shapes };
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

test("a context-length rejection is NOT replaced by 'no choices' (#50)", async () => {
  const { error, shapes } = await serve(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ error: { message: "context length exceeded", type: "invalid_request_error" } })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    },
    (url) => chatStream(cfg(url), MSGS, []),
  );
  assert.match(error?.message ?? "", /context length exceeded/i, "the original error must survive (#50)");
  assert.ok(
    !shapes.includes(false),
    `a failed stream must not be re-issued as a non-streaming request (#50); saw shapes ${JSON.stringify(shapes)}`,
  );
});

test("a 500 is not retried in another shape (#50)", async () => {
  const { error, shapes } = await serve(
    (_req, res) => json(res, 500, { error: { message: "upstream exploded" } }),
    (url) => chatStream(cfg(url), MSGS, []),
  );
  assert.match(error?.message ?? "", /upstream exploded|500/i, "the provider's error must reach the caller (#50)");
  assert.ok(
    !shapes.includes(false),
    `a 5xx must not trigger the non-streaming fallback (#50); saw shapes ${JSON.stringify(shapes)}`,
  );
});

test("a 400 from the stream request DOES fall back (#50)", async () => {
  const { error, shapes } = await serve(
    (req, res, body) => {
      if (JSON.parse(body || "{}").stream === true) {
        json(res, 400, { error: { message: "streaming is not supported by this endpoint" } });
        return;
      }
      json(res, 200, {
        choices: [{ index: 0, message: { role: "assistant", content: "ok from fallback" }, finish_reason: "stop" }],
      });
    },
    (url) => chatStream(cfg(url), MSGS, []),
  );
  assert.equal(error, null, `the clean fallback must still succeed (#50): ${error?.message}`);
  assert.ok(
    shapes.includes(true) && shapes.includes(false),
    `both a streaming and a non-streaming request must be sent (#50); saw ${JSON.stringify(shapes)}`,
  );
});

test("a working stream is never re-issued (#50)", async () => {
  const { error, shapes } = await serve(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    },
    (url) => chatStream(cfg(url), MSGS, []),
  );
  assert.equal(error, null, error ? error.message : "ok");
  assert.ok(
    !shapes.includes(false),
    `a successful stream must not be retried (#50); saw ${JSON.stringify(shapes)}`,
  );
});

test("an empty choices array is reported as such (#50)", async () => {
  const { error } = await serve(
    (_req, res) => json(res, 200, { choices: [] }),
    (url) => chat(cfg(url), MSGS, []),
  );
  assert.match(error?.message ?? "", /^LLM API returned no choices/i, "the familiar prefix is kept (#50)");
  assert.match(error?.message ?? "", /empty choices array/i, "an empty candidate list is the diagnosis (#50)");
});

test("a 200 carrying an error object surfaces the provider's own message (#50)", async () => {
  const { error } = await serve(
    (_req, res) =>
      json(res, 200, {
        error: { message: "model exceeds context length", code: "context_length_exceeded" },
      }),
    (url) => chat(cfg(url), MSGS, []),
  );
  assert.match(error?.message ?? "", /no choices/i);
  assert.match(error?.message ?? "", /exceeds context length/, "the provider's diagnosis must reach the log (#50)");
  assert.match(error?.message ?? "", /context_length_exceeded/, "its code too (#50)");
});

test("an SSE body served to a non-streaming request is identified as text (#50)", async () => {
  const { error } = await serve(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "x" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    },
    (url) => chat(cfg(url), MSGS, []),
  );
  assert.match(error?.message ?? "", /no choices/i);
  assert.match(error?.message ?? "", /SSE|not a completion object/i, "a String response must be named (#50)");
});

test("a choice with no message field is distinguished from an empty list (#50)", async () => {
  const { error } = await serve(
    (_req, res) => json(res, 200, { choices: [{ index: 0, finish_reason: "stop" }] }),
    (url) => chat(cfg(url), MSGS, []),
  );
  assert.match(error?.message ?? "", /no message field/i, "a real-but-empty choice is its own case (#50)");
});

test("a 200-with-error overflow is now recognised as context overflow (#50)", async () => {
  const masked = new Error(
    "LLM API returned no choices: provider returned an error in a 200 response " +
      "(context_length_exceeded) — This model's maximum context length is 128000 tokens",
  );
  assert.equal(isContextOverflow(masked), true, "overflow must be detected through the wrapper (#50)");
});

test("an ordinary 'no choices' is still NOT an overflow (#50)", async () => {
  assert.equal(isContextOverflow(new Error("LLM API returned no choices")), false);
  assert.equal(
    isContextOverflow(
      new Error("LLM API returned no choices: response was not a completion object (14 bytes of text)"),
    ),
    false,
  );
  assert.equal(isContextOverflow(new Error("connection reset")), false);
});

test("a restored session re-applies pruning, so the prompt does not grow (#50)", async () => {
  await useTempDirs(["p50a-", "p50b-"], async ([ws, sessionDir]) => {
    const bigOut = "Z".repeat(20_000);
    const _tc = (id: string, name: string, args: unknown) => ({
      id,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    });
    const reply = (content: string, calls?: any[]): LlmResult => ({
      message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
    });
    const seed = async (agent: Agent) => {
      await agent.log.load(); 
      const s = agent.currentSession;
      const b = agent.currentBranch;
      await agent.log.append("message", s, b, { role: "user", content: "look around" });
      for (let i = 1; i <= 3; i++) {
        await agent.log.append("message", s, b, {
          role: "assistant",
          content: "reading",
          toolCalls: [{ id: `c${i}`, name: "bash", args: { command: "cat big" } }],
        });
        await agent.log.append("tool_result", s, b, {
          callId: `c${i}`,
          name: "bash",
          ok: true,
          result: bigOut,
        });
      }
      await agent.log.append("message", s, b, { role: "assistant", content: "done" });
      await agent.log.append("usage", s, b, { inputTokens: 9_000, outputTokens: 10 });
    };
    const size = (a: Agent) =>
      (a.conversation as any[]).reduce((s, m) => s + (m.content?.length ?? 0), 0);
    const opts = {
      id: "t",
      workspace: ws!,
      sessionDir: sessionDir!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async () => reply("ok"),
      contextTokenBudget: 6_000,
      autoContinue: false,
    } as any;

    const first = new Agent(opts);
    await first.init();
    await seed(first);
    await first.dispose();

    const second = new Agent({ ...opts });
    await second.init();
    await second.load();
    const restoredSize = size(second);

    assert.ok(
      restoredSize > 0,
      `the restored session must have messages (#50); got ${restoredSize}`,
    );
    assert.ok(
      restoredSize < 30_000,
      `restore must re-apply pruning: ${restoredSize} chars looks un-pruned (#50)`,
    );
    const pruned = (second.conversation as any[]).filter((m) =>
      String(m.content ?? "").includes("[pruned"),
    );
    assert.ok(
      pruned.length >= 2,
      `the tool results outside the protected tail must be clipped (#50); clipped ${pruned.length}`,
    );
    await second.dispose();
  });
});

test("restore-pruning is idempotent — reloading again never shrinks further (#50)", async () => {
  await useTempDirs(["p50c-", "p50d-"], async ([ws, sessionDir]) => {
    const bigOut = "Z".repeat(20_000);
    const reply = (content: string): LlmResult => ({ message: { role: "assistant", content } });
    const mk = () =>
      new Agent({
        id: "t",
        workspace: ws!,
        sessionDir: sessionDir!,
        llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
        chatFn: async () => reply("ok"),
        contextTokenBudget: 6_000,
        autoContinue: false,
      } as any);
    const seed = async (agent: Agent) => {
      await agent.log.load();
      const s = agent.currentSession;
      const b = agent.currentBranch;
      await agent.log.append("message", s, b, { role: "user", content: "look around" });
      for (let i = 1; i <= 3; i++) {
        await agent.log.append("message", s, b, {
          role: "assistant",
          content: "reading",
          toolCalls: [{ id: `c${i}`, name: "bash", args: { command: "cat" } }],
        });
        await agent.log.append("tool_result", s, b, {
          callId: `c${i}`,
          name: "bash",
          ok: true,
          result: bigOut,
        });
      }
      await agent.log.append("message", s, b, { role: "assistant", content: "done" });
      await agent.log.append("usage", s, b, { inputTokens: 9_000, outputTokens: 10 });
    };
    const size = (a: Agent) => (a.conversation as any[]).reduce((s, m) => s + (m.content?.length ?? 0), 0);

    const first = mk();
    await first.init();
    await seed(first);
    await first.dispose();

    const sizes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = mk();
      await a.init();
      await a.load();
      sizes.push(size(a));
      await a.dispose();
    }
    assert.equal(sizes[1], sizes[0], `a second reload must not shrink the context further (#50): ${sizes.join(", ")}`);
    assert.equal(sizes[2], sizes[0], `a third reload must not shrink it either (#50): ${sizes.join(", ")}`);
  });
});

test("restore-pruning never clips a ONE-SHOT tool result (#50)", async () => {
  await useTempDirs(["p50e-", "p50f-"], async ([ws, sessionDir]) => {
    const bigOut = "Z".repeat(20_000);
    const reply = (content: string): LlmResult => ({ message: { role: "assistant", content } });
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sessionDir!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async () => reply("ok"),
      contextTokenBudget: 6_000,
      autoContinue: false,
    } as any);
    await a.init();
    await a.log.load();
    const s = a.currentSession;
    const b = a.currentBranch;
    await a.log.append("message", s, b, { role: "user", content: "go" });
    for (const [i, name] of ["spawn_agent", "read_url"].entries()) {
      await a.log.append("message", s, b, {
        role: "assistant",
        content: "working",
        toolCalls: [{ id: `c${i}`, name, args: {} }],
      });
      await a.log.append("tool_result", s, b, {
        callId: `c${i}`,
        name,
        ok: true,
        result: bigOut,
      });
    }
    await a.log.append("message", s, b, { role: "assistant", content: "done" });
    await a.log.append("usage", s, b, { inputTokens: 9_000, outputTokens: 10 });
    await a.dispose();

    const c = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sessionDir!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async () => reply("ok"),
      contextTokenBudget: 6_000,
      autoContinue: false,
    } as any);
    await c.init();
    await c.load();
    const preserved = (c.conversation as any[]).filter(
      (m) => m.role === "tool" && (m.content ?? "").length === bigOut.length,
    );
    assert.equal(
      preserved.length,
      2,
      `one-shot tool results must survive restore intact (#50); kept ${preserved.length} of 2`,
    );
    await c.dispose();
  });
});

test("a hostile or non-object body still yields a diagnosis, never a TypeError (#50)", async () => {
  for (const body of ["null", '"just a string"', "123", "[]"]) {
    const { error } = await serve(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      },
      (url) => chat(cfg(url), MSGS, []),
    );
    assert.match(
      error?.message ?? "",
      /no choices/i,
      `a body of ${body} must be diagnosed, not crash (#50); got: ${error?.message}`,
    );
  }
});

test("restore-pruning leaves an OLD log without a usage event alone (#50)", async () => {
  await useTempDirs(["p50g-", "p50h-"], async ([ws, sessionDir]) => {
    const bigOut = "Z".repeat(20_000);
    const reply = (content: string): LlmResult => ({ message: { role: "assistant", content } });
    const a = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sessionDir!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async () => reply("ok"),
      contextTokenBudget: 6_000,
      autoContinue: false,
    } as any);
    await a.init();
    await a.log.load();
    const s = a.currentSession;
    const b = a.currentBranch;
    await a.log.append("message", s, b, { role: "user", content: "look around" });
    await a.log.append("message", s, b, {
      role: "assistant",
      content: "reading",
      toolCalls: [{ id: "c1", name: "bash", args: { command: "cat" } }],
    });
    await a.log.append("tool_result", s, b, { callId: "c1", name: "bash", ok: true, result: bigOut });
    await a.log.append("message", s, b, { role: "assistant", content: "done" });
    await a.dispose();

    const c = new Agent({
      id: "t",
      workspace: ws!,
      sessionDir: sessionDir!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async () => reply("ok"),
      contextTokenBudget: 6_000,
      autoContinue: false,
    } as any);
    await c.init();
    await c.load();
    assert.ok(
      (c.conversation as any[]).length >= 3,
      `a legacy log must still restore its history (#50); got ${(c.conversation as any[]).length} messages`,
    );
    await c.dispose();
  });
});

test("a 200 stream with ZERO chunks still falls back (#50)", async () => {
  const { error, shapes } = await serve(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("");
    },
    (url) => chatStream(cfg(url), MSGS, []),
  );
  assert.ok(
    shapes.includes(false),
    `an empty 200 stream must still try the non-streaming shape (#50); saw ${JSON.stringify(shapes)}`,
  );
  assert.match(error?.message ?? "", /no choices|empty completion/i, `needs a diagnosis (#50): ${error?.message}`);
});

test("a transient 429 must NOT trigger the fallback (#50)", async () => {
  const { shapes } = await serve(
    (_req, res) => json(res, 429, { error: { message: "slow down" } }),
    (url) => chatStream(cfg(url), MSGS, []),
  );
  assert.ok(
    !shapes.includes(false),
    `a 429 is transient, not a capability rejection (#50); saw ${JSON.stringify(shapes)}`,
  );
});

test("an auth failure must NOT trigger the fallback (#50)", async () => {
  const { error, shapes } = await serve(
    (_req, res) => json(res, 401, { error: { message: "invalid api key" } }),
    (url) => chatStream(cfg(url), MSGS, []),
  );
  assert.match(error?.message ?? "", /invalid api key|401/i, "the auth error must reach the caller (#50)");
  assert.ok(
    !shapes.includes(false),
    `a 401 must not be retried in another shape (#50); saw ${JSON.stringify(shapes)}`,
  );
});

test("the non-JSON bodies that used to throw a bare SyntaxError are diagnosed (#50)", async () => {
  for (const [label, ct, body] of [
    ["SSE", "text/event-stream", 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n'],
    ["html", "text/html", "<html>oops</html>"],
    ["empty", "text/plain", ""],
  ] as const) {
    const { error } = await serve(
      (_req, res) => {
        res.writeHead(200, { "content-type": ct });
        res.end(body);
      },
      (url) => chat(cfg(url), MSGS, []),
    );
    assert.match(
      error?.message ?? "",
      /no choices/i,
      `a ${label} body must be diagnosed, not crash (#50); got: ${error?.message}`,
    );
    assert.doesNotMatch(
      error?.message ?? "",
      /SyntaxError|Unexpected token|JSON/i,
      `a ${label} body must not surface a raw parse error (#50); got: ${error?.message}`,
    );
  }
});
