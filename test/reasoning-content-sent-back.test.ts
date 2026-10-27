import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chat } from "../src/agent/llm.ts";
import type { ChatMessage } from "../src/agent/llm.ts";

/**
 * An earlier assistant turn's thinking must be sent BACK to the provider (#187).
 *
 * MEASURED on `mizuki-rakutenai-3-205c7912`: every follow-up request failed with
 * `Missing required parameter: 'messages[2].reasoning_content'. This model needs the reasoning of
 * every earlier assistant message`. Only the first request ever worked.
 *
 * The cause was not a missing feature but a dropped field: the log recorded `reasoning: res.reasoning`
 * for the timeline, while `this.messages.push(m)` stored a message with NO reasoning. So the transcript
 * the model got back had the thinking stripped from every prior turn — for a provider that requires it,
 * a hard 400; for the rest, a silently lost chain of thought mid-task.
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
          id: "x", object: "chat.completion", created: 0, model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  try {
    await chat({ baseUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`, apiKey: "k", model: "m" }, messages, []);
  } finally {
    srv.close();
  }
  if (!body) throw new Error("the request must have been made");
  return (body as { messages: Record<string, unknown>[] }).messages;
}

test("an assistant turn's thinking rides back as reasoning_content (#187)", async () => {
  const sent = await capture([
    { role: "user", content: "read the parser" },
    { role: "assistant", content: "reading", reasoning: "I should open parsers/x.ts first" },
    { role: "user", content: "continue" },
  ]);
  const a = sent.find((m) => m.role === "assistant");
  assert.equal(a?.reasoning_content, "I should open parsers/x.ts first", "without this the request is a 400");
});

test("our internal `reasoning` field never reaches the API (#187)", async () => {
  const sent = await capture([
    { role: "user", content: "x" },
    { role: "assistant", content: "y", reasoning: "internal" },
  ]);
  for (const m of sent) assert.equal("reasoning" in m, false, `leaked on ${String(m.role)}`);
});

test("only assistant turns carry it (#187)", async () => {
  // a user prompt or a tool result has no thinking; an empty field there is noise, and some providers
  // reject the request outright
  const sent = await capture([
    { role: "user", content: "x" },
    { role: "assistant", content: "y", reasoning: "thought" },
    { role: "tool", tool_call_id: "c1", content: "result" },
  ]);
  for (const m of sent) {
    if (m.role === "assistant") continue;
    assert.equal("reasoning_content" in m, false, `leaked on ${String(m.role)}`);
  }
});

test("an assistant turn with NO thinking still carries the field, empty (#187)", async () => {
  /**
   * PRESENCE is what these providers check, across the WHOLE history — not "did this turn think".
   *
   * MEASURED reference: `ClawRouter` patches every assistant message with `reasoning_content: ""` when
   * absent, and its comment states why — "reasoning models require it on every assistant turn in
   * history, not just tool-call turns". A turn whose thinking the provider did not return, or which was
   * compacted away, would otherwise make the whole conversation fail with 400.
   */
  const sent = await capture([
    { role: "user", content: "x" },
    { role: "assistant", content: "plain answer" },
  ]);
  const a = sent.find((m) => m.role === "assistant");
  assert.equal(a?.reasoning_content, "", "present and empty, so the history is accepted");
  assert.equal(a?.content, "plain answer", "and the visible text is untouched");
});

test("the field is present on EVERY assistant turn, not only the ones that thought (#187)", async () => {
  const sent = await capture([
    { role: "user", content: "a" },
    { role: "assistant", content: "thought about it", reasoning: "deep thought" },
    { role: "user", content: "b" },
    { role: "assistant", content: "no thinking this time" },
  ]);
  const asst = sent.filter((m) => m.role === "assistant");
  assert.equal(asst.length, 2);
  assert.equal(asst[0]?.reasoning_content, "deep thought");
  assert.equal(asst[1]?.reasoning_content, "", "the second turn must not be the one that breaks the request");
});

test("the spelling follows what the provider ADVERTISES (#187)", async () => {
  /**
   * One field name cannot work everywhere: MEASURED, OpenRouter's `/models` lists `reasoning` in
   * `supported_parameters` and it rejects a key it does not know, while Command Code advertises nothing
   * and its DeepSeek models require `reasoning_content`.
   *
   * So the name is chosen from the provider's OWN catalogue — the one thing that distinguishes them
   * without a failed request to learn from.
   */
  const messages: ChatMessage[] = [
    { role: "user", content: "x" },
    { role: "assistant", content: "y", reasoning: "thought" },
  ];
  const openrouter = await captureWith(messages, ["tools", "reasoning"]);
  const openrouterAsst = openrouter.find((m) => m.role === "assistant")!;
  assert.equal(openrouterAsst.reasoning, "thought", "an OpenRouter-style provider gets `reasoning`");
  assert.equal("reasoning_content" in openrouterAsst, false, "and NOT the DeepSeek spelling");

  const cc = await captureWith(messages, undefined);
  const ccAsst = cc.find((m) => m.role === "assistant")!;
  assert.equal(ccAsst.reasoning_content, "thought", "a silent provider gets `reasoning_content`");
  assert.equal("reasoning" in ccAsst, false);
});

/** same capture, but passing the advertised parameter list the way the agent does */
async function captureWith(
  messages: ChatMessage[],
  supportedParameters: string[] | undefined,
): Promise<Record<string, unknown>[]> {
  let body: { messages: Record<string, unknown>[] } | null = null;
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      body = JSON.parse(b);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x", object: "chat.completion", created: 0, model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  try {
    await chat(
      {
        baseUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`,
        apiKey: "k",
        model: "m",
        ...(supportedParameters ? { supportedParameters } : {}),
      },
      messages,
      [],
    );
  } finally {
    srv.close();
  }
  if (!body) throw new Error("the request must have been made");
  return (body as { messages: Record<string, unknown>[] }).messages;
}
