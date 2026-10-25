import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * An echo belongs to the SESSION OF THE AGENT THAT WAS PROMPTED — not to the timeline on screen.
 *
 * Reported as "⏳ 1 message queued" on `tyb2-9-8155867c` while the server had
 * `pendingPrompts: 0 / pendingPromptIds: [] / pendingPromptQueue: []` (measured against the live
 * API). The count came from a stale client-side echo, and the reason it was there is that TWO
 * writers filed echoes under `pendingKey()` — "whatever timeline is being viewed" — even though the
 * subject of both was a specific AGENT:
 *
 *   - `sendText()` filed the echo of a prompt it had just POSTed to `id`;
 *   - the queue-rebuild effect read `sel().pendingPromptQueue` (the SELECTED AGENT) and wrote under
 *     `pendingKey()` (the VIEWED TIMELINE).
 *
 * Those are the same handle for a live agent and different for anyone else's session, which is
 * ordinary: a harness prompt targets an agent that is not selected, and the left panel lists
 * sessions that are not the one on screen. MEASURED on the built bundle, two agents on two
 * sessions: prompting `s1` while viewing `s2` left `s2` with no badge and no message (correct),
 * and switching to `s1` showed `⏳ 1 message queued` (correct). Before the fix `s2` showed the
 * badge AND drew `s1`'s message in its own feed.
 *
 * `queuedCount()` had the same mix: `sel()` is an agent and `pendingMsgs()` is the visible
 * timeline, so `Math.max` of the two raised a badge for a queue the visible session did not have.
 */
test("echoes are filed under the prompted agent's session, never the viewed timeline (#87)", () => {
  const app = readFileSync("frontend/App.tsx", "utf8");

  // `sendText` knows which agent it prompted; the echo must use THAT, not `pendingKey()`.
  const sendAt = app.indexOf("const sendText = async");
  assert.ok(sendAt > 0, "sendText must exist");
  const sendBlock = app.slice(sendAt, app.indexOf("} catch", sendAt));
  assert.match(sendBlock, /const echoKey = agents\(\)\.find\(\(a\) => a\.id === id\)\?\.session/, "the echo key must be derived from the prompted agent's session");
  assert.match(sendBlock, /writePending\(echoKey,/, "and the send path must write under it");
  assert.doesNotMatch(sendBlock, /writePending\(pendingKey\(\)/, "writing under the viewed timeline is the reported bug");

  // The queue-rebuild effect reads `sel()`, so it must write under that agent's session too.
  const rebuildAt = app.indexOf("const queue = sel()?.pendingPromptQueue;");
  assert.ok(rebuildAt > 0, "the queue-rebuild effect must exist");
  const rebuildBlock = app.slice(rebuildAt, rebuildAt + 700);
  assert.match(rebuildBlock, /const key = sel\(\)\?\.session \|\| pendingKey\(\);/, "the rebuild must be filed by the queue's OWNER");

  // The badge compares two counts; both must describe the same feed.
  const countAt = app.indexOf("const queuedCount = () =>");
  assert.ok(countAt > 0, "queuedCount must exist");
  const countBlock = app.slice(countAt, app.indexOf("};", countAt));
  assert.match(countBlock, /sel\(\)\?\.session === pendingKey\(\)/, "the server count is only about the visible feed when the sessions agree");
});
