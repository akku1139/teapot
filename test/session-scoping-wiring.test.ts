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

test("an event from ANOTHER session is never merged (#146, #54)", () => {
  const b = branch("event");
  // #146: the check now lives in frontend/session-scope.ts — assert the HANDLER
  // consults it, because deleting the call still has to fail here.
  // #54: it must be the SHARED predicate. The inline form read `timelineId()`
  // directly, and that is exactly what broke: with no session resolved yet
  // `timelineId()` is the AGENT ID, so comparing it against an event's real
  // session dropped EVERY frame and only REST moved the feed.
  assert.match(
    b,
    /eventBelongsOnTimeline\(/,
    "the event filter must go through the shared session predicate (#146)",
  );
  assert.doesNotMatch(
    b,
    /session !== timelineId\(\)/,
    "the inline comparison IS #54 — the fallback view must be exempt (#54)",
  );
});

test("the session check comes AFTER the notification, so cross-session still notifies (#146)", () => {
  // the notification centre is session-independent; a cross-session event must
  // still raise a notification, it just must not enter the feed
  const b = branch("event");
  const notify = b.indexOf("maybeNotify");
  const sessionCheck = b.indexOf("eventBelongsOnTimeline(");
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

