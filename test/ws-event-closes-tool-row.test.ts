/**
 * #145 — a socket-delivered `tool_result` does not close its `tool_call` row.
 *
 * ## The regression
 *
 * #54 made the socket's payload the timeline's data:
 *
 *     if (msg.event) { mergeEvents([msg.event as Ev]); void refreshMetrics(); return; }
 *
 * That `return` is the bug. It replaced the old `setTimeout(runFeedRefresh, 120)`,
 * and `runFeedRefresh` did two things `mergeEvents` cannot:
 *
 *     await refreshAgents();      // the agent's live STATUS
 *     await loadEvents(selected()) // re-derive the feed from the log
 *
 * Without `refreshAgents`, `agentActive` stays whatever it was. `ToolRow` closes a
 * stranded call with:
 *
 *     const staleDone = !props.agentActive && !res;
 *
 * so a still-reported-live agent never falls back to `staleDone`, and the row
 * sits at "running…" until something reloads the feed.
 *
 * ## Why merging alone cannot do it
 *
 * `pairInfo` walks `events()` in order and pairs a result with a call it has
 * ALREADY seen. A result delivered before its call row exists in the window cannot
 * pair — it becomes an `orphanCall`, rendered as a bare anonymous row — while the
 * original call keeps rendering "running…".
 *
 * So the socket payload must still drive a real feed pass. It just no longer has
 * to be the ONLY path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockFrom, readSource, stripSourceComments } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// comments are STRIPPED — see stripSourceComments for why (#75)
const app = stripSourceComments(readSource(path.join(here, "..", "frontend", "App.tsx")));

/** the body of the `kind === "event"` branch */
function eventBranch(): string {
  const at = app.indexOf('if (msg.kind === "event") {');
  assert.notEqual(at, -1, "the WS event branch must exist (#145)");
  // Bound by the branch's own closing brace at 6-space indent.
  //
  // A sibling-`if` search found nothing (there is no following `msg.kind`
  // branch), so this fell back to a 2500-char window — and #145's explanatory
  // comment pushed the body past it, so the slice contained neither `mergeEvents`
  // nor `refreshAgents`. Fixed width hiding the thing it was meant to check.
  // Bound by the LAST statement of the branch, not by its closing brace.
  //
  // Two earlier bounds were wrong: a sibling-`if` search found none (there is no
  // following `msg.kind` branch), and `indexOf("\n      }")` landed INSIDE the
  // long explanatory comment, returning a slice that started AFTER the code — so
  // the regression mutation was invisible to every assertion here.
  const rest = app.slice(at);
  const anchor = rest.lastIndexOf("mergeEvents([msg.event as Ev])");
  assert.notEqual(anchor, -1, "the branch must merge the payload (#54)");
  // from the branch start through the refresh it schedules
  const after = rest.indexOf("runFeedRefresh", anchor);
  assert.notEqual(after, -1, "the branch must reach a refresh (#145)");
  return rest.slice(0, rest.indexOf(";", after) + 1);
}

test("a socket event still refreshes the agent's live status (#145)", () => {
  // The rule: the event path must SCHEDULE the refresh, because that is what
  // re-reads the agent's status — without it `agentActive` never changes and a
  // stranded tool row never closes.
  //
  // The pattern used to be /refreshAgents\(\)|runFeedRefresh\(\)/, which cannot
  // match the call the code makes (`setTimeout(runFeedRefresh, 60)`): the test
  // passed only because `refreshAgents()` appeared in the explanatory COMMENT.
  // Comments are stripped here now, so it asserts the real invocation.
  assert.match(
    eventBranch(),
    /runFeedRefresh\b/,
    "the event path must reach the refresh that refreshes agent status (#145)",
  );
});

