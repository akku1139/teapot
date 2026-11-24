/**
 * Thinking must survive the tool call it produced (#286).
 *
 * "thinking -> tool call ってしたときにタイムラインからthinkingの内容が消える". While the turn streams, the reasoning lives in
 * the live buffer. `startedToolCallSince` then declares it stale as soon as a `tool_call` is logged after the buffer started
 * — on the assumption that the assistant message carrying the same reasoning has already landed. It may not have: the
 * message is written by the SAME turn, and the tool call is what follows it, so the check has to ask whether the LOG
 * actually carries this text rather than whether a tool call has started.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { liveBufferRemainder } from "../frontend/lib/live-buffer.ts";

const T = "2026-01-01T00:00:00.000Z";
const buf = { text: "", reasoning: "I should read the config first", at: Date.parse(T) };

const toolCallAfter = (opts: { reasoningLogged: boolean }) => [
  ...(opts.reasoningLogged
    ? [
        {
          type: "message",
          ts: "2026-01-01T00:00:01.000Z",
          data: { role: "assistant", content: "", reasoning: buf.reasoning },
        },
      ]
    : []),
  { type: "tool_call", ts: "2026-01-01T00:00:02.000Z", data: { name: "bash" } },
];

test("the reasoning stays while the log does not have it yet", () => {
  const out = liveBufferRemainder(buf, toolCallAfter({ reasoningLogged: false }), "running");
  assert.equal(out.reasoning, buf.reasoning, "a tool call having started is not the same as the thinking being logged");
});

test("once the log carries the same reasoning, the buffer drops it", () => {
  const out = liveBufferRemainder(buf, toolCallAfter({ reasoningLogged: true }), "running");
  assert.equal(out.reasoning, "", "the row in the log is the only copy that should render");
});
