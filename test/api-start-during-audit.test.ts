/**
 * The prompt API must not skip `start()` just because the status says `running` (#262 follow-up).
 *
 * MEASURED mechanism behind "audit中にプロンプトを送るとaudit完了してもwaitingステータスが切れずにデッドロックしてそう": a
 * `finish(goalComplete)` holds the run inside its own handler for the whole completion audit and then ENDS the loop. A prompt
 * sent in that window was queued, the API saw `status === "running"` and did not call `start()`, so nothing ever drained it —
 * the agent stayed live/waiting with the message still queued.
 *
 * `Agent.start()` already returns early when a round is genuinely in flight, so calling it unconditionally is safe. This test
 * pins the CALL SITE, because that is where the wrong decision was made.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the prompt route always calls start() when the caller did not opt out", () => {
  const src = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");
  const at = src.indexOf("const ahead = a.pendingAheadOf(promptId);");
  assert.ok(at > 0, "the prompt handler must exist");
  const tail = src.slice(at, at + 900);
  assert.match(tail, /if \(body\.start !== false\) a\.start\("prompt"\);/, "no status guard: start() decides");
  assert.doesNotMatch(tail, /a\.status !== "running"\) a\.start/, "the removed guard must not come back");
});

test("start() is a no-op while a round really is in flight", () => {
  const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  const at = src.indexOf("start(reason = \"start\"): void {");
  assert.ok(at > 0);
  const head = src.slice(at, at + 260);
  assert.match(head, /if \(this\.status === "running" && !pendingStop\) return;/, "the early return is what makes the call safe");
});
