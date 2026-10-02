/**
 * #50 — "`⚠ LLM API returned no choices`" — "seems to happen in a session that
 *        resumes after a teapot restart. Details unknown."
 *
 * The message turned out to be a SYMPTOM, not the failure. The agent never
 * calls the non-streaming `chat()` directly — it calls `chatStream`, which
 * falls back to `chat()` when the stream produced nothing. So seeing "no
 * choices" proved only that the FIRST (streaming) request had already failed,
 * and the fallback then replaced its diagnosis with this one.
 *
 * The masking, concretely: when a gateway serves an SSE body to a
 * non-streaming request, the OpenAI SDK hands `chat()` a plain String, so
 * `res.choices` is undefined and every distinct failure collapses into the
 * same line — a 200 carrying an error object, an empty choices array, a
 * streaming delta, and raw SSE text. For a restored 1500-message session the
 * real error was a context-length rejection, and `isContextOverflow()` could
 * never match the replacement text, so the compact-and-retry recovery never
 * ran and the turn failed after four attempts.
 *
 * Three fixes, one per link in that chain:
 *   1. the fallback no longer fires when the stream attempt itself errored —
 *      only when the provider rejected the request (a 4xx);
 *   2. "no choices" now says WHICH shape arrived, so the log is diagnosable;
 *   3. restore re-applies pruning, so a reloaded session does not hand the
 *      provider a larger prompt than the one that just succeeded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { useTempDirs } from "./helpers/tmp.ts";
import { chat, chatStream, type ChatMessage, type LlmConfig } from "../src/agent/llm.ts";
import { isContextOverflow } from "../src/agent/tools.ts";
import { Agent } from "../src/agent/agent.ts";
import type { LlmResult } from "../src/agent/llm.ts";

const cfg = (baseUrl: string): LlmConfig => ({ baseUrl, apiKey: "k", model: "m" } as any);
const MSGS: ChatMessage[] = [{ role: "user", content: "hi" }];

/**
 * Run `call` against a local server and report what it answered with.
 *
 * NOTE on counting: the number of HTTP requests is deliberately NOT asserted
 * anywhere in this file. The OpenAI SDK retries a 5xx internally (measured:
 * three requests for one `create()` call), so a request count measures the
 * SDK's backoff rather than our behaviour. What is under test is the request
 * SHAPE — whether a second, non-streaming request was ever issued — plus the
 * error text the caller actually receives.
 */
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

/* ---------- 1: the fallback must not swallow a real error ---------- */

test("a context-length rejection is NOT replaced by 'no choices' (#50)", async () => {
  // The exact reported failure. The gateway answers the STREAMING request with
  // HTTP 200 and an SSE error frame, which the SDK turns into a thrown error.
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
  // A server error is the ANSWER, not evidence that streaming is unsupported.
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
  // The fallback exists for providers that reject `stream: true`. It must
  // survive the tightening, or those providers break. A 400 is the shape a
  // provider uses to say "I don't do that".
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
  assert.equal(error, null, error?.message);
  assert.ok(
    !shapes.includes(false),
    `a successful stream must not be retried (#50); saw ${JSON.stringify(shapes)}`,
  );
});

/* ---------- 2: "no choices" must say WHY ---------- */

test("an empty choices array is reported as such (#50)", async () => {
  const { error } = await serve(
    (_req, res) => json(res, 200, { choices: [] }),
    (url) => chat(cfg(url), MSGS, []),
  );
  assert.match(error?.message ?? "", /^LLM API returned no choices/i, "the familiar prefix is kept (#50)");
  assert.match(error?.message ?? "", /empty choices array/i, "an empty candidate list is the diagnosis (#50)");
});

test("a 200 carrying an error object surfaces the provider's own message (#50)", async () => {
  // The most valuable case: the actionable text is in the body and used to be
  // thrown away entirely.
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
  // What the SDK returns when a gateway answers the fallback with SSE: a plain
  // String, so `.choices` is undefined. Indistinguishable from everything else
  // unless the message says so.
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

/* ---------- 3: overflow recovery must recognise the 200-with-error shape ---------- */

test("a 200-with-error overflow is now recognised as context overflow (#50)", async () => {
  // This is what makes compact-and-retry fire at all. Before, the message was
  // the bare "no choices" and isContextOverflow() returned false, so a
  // restored oversized session could never recover.
  const masked = new Error(
    "LLM API returned no choices: provider returned an error in a 200 response " +
      "(context_length_exceeded) — This model's maximum context length is 128000 tokens",
  );
  assert.equal(isContextOverflow(masked), true, "overflow must be detected through the wrapper (#50)");
});

test("an ordinary 'no choices' is still NOT an overflow (#50)", async () => {
  // The widening must not make every malformed response trigger a compaction.
  assert.equal(isContextOverflow(new Error("LLM API returned no choices")), false);
  assert.equal(
    isContextOverflow(
      new Error("LLM API returned no choices: response was not a completion object (14 bytes of text)"),
    ),
    false,
  );
  assert.equal(isContextOverflow(new Error("connection reset")), false);
});

/* ---------- 4: restore must not un-prune ---------- */



/* ---------- wiring ---------- */

test("the bare message is no longer the only thing thrown (#50)", () => {
  const llm = readFileSync(new URL("../src/agent/llm.ts", import.meta.url), "utf8");
  assert.match(llm, /function noChoicesDetail/, "the diagnosis helper must exist (#50)");
  assert.doesNotMatch(
    llm,
    /throw new Error\("LLM API returned no choices"\)/,
    "the bare message is what made #50 undiagnosable (#50)",
  );
});

test("the fallback decision never reads the error message (#50)", async () => {
  // The SDK's generic prefixes contain the word "stream" ("LLM API error 500:
  // …"), so a message-based test made a 500 look like an unsupported-stream
  // rejection and re-armed the fallback this is meant to suppress. Guard the
  // shape of the decision, not just its effect.
  const llm = readFileSync(new URL("../src/agent/llm.ts", import.meta.url), "utf8");
  const fallback = llm.slice(llm.lastIndexOf("} catch (err) {"));
  assert.doesNotMatch(
    fallback,
    /streamUnsupported|\/stream\|event-source/i,
    "the fallback must key on the HTTP status, never on message text (#50)",
  );
  assert.match(
    fallback,
    /STREAM_REJECTED_STATUS\.has\(status\)/,
    "a known 'shape unsupported' status is what permits the retry (#50)",
  );
});

test("the fallback status set is an allow-list, not the whole 4xx range (#50)", async () => {
  // 408/425/429 are transient and 401/403 are auth: replaying any of them
  // without `stream` re-issues the SAME failing request, doubling provider load
  // (or a round trip) for no new information.
  const llm = readFileSync(new URL("../src/agent/llm.ts", import.meta.url), "utf8");
  const set = llm.match(/const STREAM_REJECTED_STATUS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "";
  const codes = set.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  assert.ok(codes.length > 0, "the allow-list must be declared (#50)");
  for (const transient of [408, 425, 429, 401, 403]) {
    assert.ok(
      !codes.includes(transient),
      `${transient} must not permit the non-streaming retry (#50); set is [${set.trim()}]`,
    );
  }
  // and the shapes a provider really uses to say "no streaming" must be there
  for (const shape of [400, 404, 422]) {
    assert.ok(codes.includes(shape), `${shape} is a 'shape unsupported' status and must fall back (#50)`);
  }
});

test("an empty stream is distinguishable from a rejected request (#50)", async () => {
  // The zero-chunk case is signalled by a marker, not by the message text —
  // otherwise "empty completion" and a provider rejection are indistinguishable
  // and the flaky-proxy safety net cannot be reinstated.
  const llm = readFileSync(new URL("../src/agent/llm.ts", import.meta.url), "utf8");
  assert.match(llm, /e\.emptyStream = true/, "the empty stream must be marked (#50)");
  assert.match(llm, /emptyStream === true/, "the handler must read that marker (#50)");
});

/* ---------- 4: restore must not un-prune ---------- */

test("a restored session re-applies pruning, so the prompt does not grow (#50)", async () => {
  // maybePrune() clips oversized tool output IN PLACE; the log keeps the full
  // result. Without re-pruning on restore, a reload handed the provider a
  // strictly larger prompt than the one that had just succeeded.
  //
  // The oversized output must sit in the PRUNED region, not the protected tail:
  // maybePrune() guards roughly the last `budget * 2` characters, so one big
  // result at the end is never a candidate and the assertion would pass for the
  // wrong reason. Several long results, then a short exchange, puts the earlier
  // ones outside that guard.
  await useTempDirs(["p50a-", "p50b-"], async ([ws, sessionDir]) => {
    const bigOut = "Z".repeat(20_000);
    const tc = (id: string, name: string, args: unknown) => ({
      id,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    });
    const reply = (content: string, calls?: any[]): LlmResult => ({
      message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) },
    });
    // A tool result the agent cannot easily author itself — write it straight
    // into the log so the oversized output is exactly the size we want on
    // restore. The assistant turn MUST carry `toolCalls` (not just a separate
    // `tool_call` event): that is what rebuildMessagesFrom turns into
    // `m.tool_calls`, and maybePrune resolves a result's prunability through
    // them. Seeding the wrong shape would silently test nothing.
    const seed = async (agent: Agent) => {
      await agent.log.load(); // assigns seq; append() needs it
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
      // a realistic context size, so maybePrune() engages on restore
      await agent.log.append("usage", s, b, { inputTokens: 9_000, outputTokens: 10 });
    };
    const size = (a: Agent) =>
      (a.messages as any[]).reduce((s, m) => s + (m.content?.length ?? 0), 0);
    const opts = {
      id: "t",
      workspace: ws!,
      sessionDir: sessionDir!,
      llm: { baseUrl: "http://x", apiKey: "k", model: "m" } as any,
      chatFn: async () => reply("ok"),
      // small enough that 3 × 20KB of tool output is well past the threshold
      contextTokenBudget: 6_000,
      autoContinue: false,
    } as any;

    const first = new Agent(opts);
    await first.init();
    await seed(first);
    await first.dispose();

    // restore into a fresh agent over the same log
    const second = new Agent({ ...opts });
    await second.init();
    await second.load();
    const restoredSize = size(second);

    assert.ok(
      restoredSize > 0,
      `the restored session must have messages (#50); got ${restoredSize}`,
    );
    // Un-pruned, this restore is 3 × 20KB ≈ 60k chars. maybePrune() guards the
    // last `budget * 2` characters from clipping, so the final tool result is
    // legitimately preserved — the assertion is that the EARLIER ones, which
    // sit outside that guard, were clipped.
    assert.ok(
      restoredSize < 30_000,
      `restore must re-apply pruning: ${restoredSize} chars looks un-pruned (#50)`,
    );
    const pruned = (second.messages as any[]).filter((m) =>
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
  // Pruning rewrites the IN-MEMORY messages, not the log, so each reload
  // starts from the same full log. If restore clipped a clipped string the
  // context would bleed away a little more on every restart, which is the
  // opposite failure to the one #50 reports.
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
    const size = (a: Agent) => (a.messages as any[]).reduce((s, m) => s + (m.content?.length ?? 0), 0);

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
  // maybePrune() only clips tools whose output the model can re-issue. A
  // sub-agent's report or a fetched page cannot be re-fetched, so clipping one
  // on restore would silently destroy information the live path deliberately
  // kept — and it would now happen silently on every restart.
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
    const preserved = (c.messages as any[]).filter(
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
  // Proxies do return `null` and bare scalars on some error paths. Reading
  // `res.choices` unguarded threw "Cannot read properties of null", which
  // names neither the provider nor the shape — the exact opacity #50 reports.
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
  // Migration case: logs written before usage events existed have nothing to
  // seed lastUsage from, so the 0.6-of-budget gate cannot be met. Restore must
  // still succeed and simply not prune — never throw, never lose messages.
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
    // deliberately NO usage event — a legacy log
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
      (c.messages as any[]).length >= 3,
      `a legacy log must still restore its history (#50); got ${(c.messages as any[]).length} messages`,
    );
    await c.dispose();
  });
});

/* ---------- adversarial QA follow-ups ---------- */

test("a 200 stream with ZERO chunks still falls back (#50)", async () => {
  // Regression found in review: tightening the fallback to "the provider
  // rejected the request" deleted the safety net for a broken/flaky proxy
  // that opens an SSE response, sends nothing, and closes cleanly. That case
  // used to recover via the non-streaming retry and then hard-failed.
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
  // whatever the outcome, it must be a diagnosis rather than a bare TypeError
  assert.match(error?.message ?? "", /no choices|empty completion/i, `needs a diagnosis (#50): ${error?.message}`);
});

test("a transient 429 must NOT trigger the fallback (#50)", async () => {
  // Keying on "any 4xx" would replay an identical request against a provider
  // that just asked us to slow down, doubling the load for nothing. 400/404/
  // 405/422/501 mean the SHAPE is unsupported; 408/425/429 do not.
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
  // 401 is not fixed by dropping `stream`, so a fallback there replaces one
  // honest error with the same error and a wasted round trip.
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
  // The scenario the fix is NAMED for: a gateway serves an SSE body to a
  // non-streaming request. Whichever layer hands the text over — the SDK
  // returning a String or throwing during its own parse — the operator must
  // get a diagnosis naming the shape, never "Unexpected token 'd'".
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
