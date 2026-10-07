/**
 * #146 — the session filters are WIRED, not merely defined.
 *
 * `test/session-isolation.test.ts` proves the *predicates* are right. It cannot
 * prove the handler uses them: removing the session check from `App.tsx` left that
 * file fully green, and even the `agentActive` shape assertion did not notice,
 * because it matches an expression that survives the removal elsewhere.
 *
 * So these assert the guards are present in the actual handler branches, by
 * locating each branch and requiring the check inside it — and each is written so
 * that deleting the guard fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readSource(path.join(here, "..", "frontend", "App.tsx"));

/** from a `if (msg.kind === "…") {` branch to its closing brace at 6-space indent */
function branch(kind: string): string {
  const at = app.indexOf(`if (msg.kind === "${kind}") {`);
  assert.notEqual(at, -1, `the ${kind} handler must exist (#146)`);
  const rest = app.slice(at);
  // bound by the merge/refresh the branch performs, else by its own close
  const end = rest.indexOf("\n      }", 10);
  assert.notEqual(end, -1, `the ${kind} branch must be terminated (#146)`);
  return rest.slice(0, end);
}

test("a live delta from ANOTHER session is dropped (#146)", () => {
  const b = branch("llm-delta");
  // the check now lives in frontend/session-scope.ts (deltaBelongsToTimeline):
  // assert the HANDLER consults it — deleting the guard still fails here
  assert.match(
    b,
    /deltaBelongsToTimeline\(msg, selected\(\), timelineId\(\)\)/,
    "the delta must be attributed to the DISPLAYED session, not just the agent (#146)",
  );
});

test("an event from ANOTHER session is never merged (#146)", () => {
  const b = branch("event");
  assert.match(
    b,
    /timelineId\(\)/,
    "the event filter must consult the session (#146)",
  );
  assert.match(
    b,
    /session !== timelineId\(\)/,
    "and reject an event whose session differs (#146)",
  );
});

test("the session check comes AFTER the notification, so cross-session still notifies (#146)", () => {
  // the notification centre is session-independent; a cross-session event must
  // still raise a notification, it just must not enter the feed
  const b = branch("event");
  const notify = b.indexOf("maybeNotify");
  const sessionCheck = b.indexOf("session !== timelineId()");
  assert.ok(notify !== -1, "maybeNotify must run (#79/#106)");
  assert.ok(
    sessionCheck === -1 || notify < sessionCheck,
    "the notification must fire before the feed filter (#146)",
  );
});

test("the llm-delta protocol carries a session id (#146)", async () => {
  // the client CANNOT attribute a stream without it, so this is not optional
  const { readFileSync } = await import("node:fs");
  const bus = readFileSync(new URL("../src/bus.ts", import.meta.url), "utf8");
  assert.match(
    bus,
    /kind: "llm-delta"; agentId: string; sessionId: string;/,
    "llm-delta must carry a REQUIRED sessionId (#146)",
  );
  assert.doesNotMatch(
    bus,
    /kind: "llm-delta"; agentId: string; \?/,
    "optional would leave every existing emitter unattributable (#146)",
  );
});

test("every llm-delta emitter supplies its session (#146)", async () => {
  const { readFileSync } = await import("node:fs");
  const agent = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");
  const emissions = agent.match(/kind: "llm-delta"/g) ?? [];
  const withSession = agent.match(/kind: "llm-delta"[\s\S]{0,200}?sessionId:/g) ?? [];
  assert.ok(emissions.length > 0, "there must be emissions to check (#146)");
  assert.equal(
    withSession.length,
    emissions.length,
    `every llm-delta must name its session (#146): ${emissions.length} emissions, ${withSession.length} with a sessionId`,
  );
});

test("ToolRow activity is session-scoped (#120, #133, #146)", () => {
  assert.match(
    app,
    /agentActive=\{[\s\S]{0,200}?isTimelineLive\(\) && isOwnLiveWork\(e\)/,
    "agentActive must go through the session-scoped liveness (#146)",
  );
  assert.match(
    app,
    // the body also carries the #146-fallback branch (timelineId === agent id
    // = the newest tail is live), so the window is wider than the bare compare
    /const isTimelineLive = \(\): boolean => \{[\s\S]{0,800}?return running === shown;/,
    "and that liveness must compare the agent's session with the displayed one (#146)",
  );
});
