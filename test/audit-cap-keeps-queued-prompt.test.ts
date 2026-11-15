/**
 * The audit's reject CAP must not swallow a prompt that arrived during the audit (#262 follow-up).
 *
 * The cap branch `break`s out of the round loop, and it sits BEFORE the `pendingPrompts` check — so a prompt that arrived while
 * the audit was running stayed queued with nothing to drain it. `isLive()` reads `pendingPrompts.length > 0`, so the agent showed
 * `waiting` for ever and the message was never delivered: "audit中にプロンプトを送るとaudit完了してもwaitingステータスが切れずに
 * デッドロックしてそう".
 *
 * The cap is about the AUDIT loop, not about ignoring the operator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the audit cap continues while a prompt is queued", () => {
  const src = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  const at = src.indexOf('event: "audit-retry-cap"');
  assert.ok(at > 0, "the cap branch must exist");
  const tail = src.slice(at, at + 1200);
  const capEnd = tail.indexOf("break;");
  assert.ok(capEnd > 0, "the branch ends in a break");
  const guarded = tail.slice(0, capEnd);
  assert.match(
    guarded,
    /if \(this\.pendingPrompts\.length\) continue;/,
    "a queued prompt must keep the round alive instead of being stranded",
  );
});
