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
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readSource(path.join(here, "..", "frontend", "App.tsx"));

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
  // the regression: `agentActive` never updates, so `staleDone` is never reached
  assert.match(
    eventBranch(),
    /refreshAgents\(\)|runFeedRefresh\(\)/,
    "the event path must refresh agent status, or a stranded tool row never closes (#145)",
  );
});

test("a socket event still re-derives the feed (#145)", () => {
  // #141: this asserted the ABSENCE of one exact `mergeEvents(…); return;` shape.
  // Restoring the regression as `mergeEvents(…); return;` with a comment instead of
  // `void refreshMetrics()` in between left it GREEN — the regex was pinned to a
  // formatting detail, not to the rule.
  //
  // The rule: after merging, the branch must not end. Anything after `mergeEvents`
  // that is a bare `return` is the regression, whatever precedes it.
  const b = eventBranch();
  const mergeAt = b.indexOf("mergeEvents([");
  assert.notEqual(mergeAt, -1, "the payload must be merged (#54)");
  const tail = b.slice(mergeAt + "mergeEvents([".length);
  // every `return` after the merge, with its guard
  for (const m of tail.matchAll(/if \(([^)]*)\)[^\n]*return;/g)) {
    const cond = m[1]!;
    // Two guards legitimately return here: a hidden tab defers the work, and
    // `if (timer) return` is the debounce — a refresh is already scheduled.
    // Neither ends the branch without a refresh being PENDING.
    assert.ok(
      /visibilityState|\btimer\b/.test(cond),
      `only the hidden-tab or debounce guard may return after the merge (#145); found \`if (${cond}) return;\``,
    );
  }
  // #141: everything else accepted `if (timer) return;` — but under the
  // regression that guard is UNREACHABLE, so the branch ends without ever
  // scheduling a refresh. The rule is about REACHABILITY: a refresh must be
  // scheduled with no intervening bare return on any path.
  const bareReturn = /\breturn;/.test(tail.replace(/if \([^)]*\)[^\n]*return;/g, ""));
  assert.equal(
    bareReturn,
    false,
    `no BARE return may follow the merge (#145) — found \`${tail.match(/[^\n]*\breturn;[^\n]*/)?.[0]}\``,
  );
  // and the refresh must be scheduled before the branch's own end
  assert.match(
    tail,
    /setTimeout\(runFeedRefresh/,
    "the branch must schedule a feed refresh, or tool rows never close (#145)",
  );
  assert.doesNotMatch(
    tail,
    /\n\s*\n\s*return;\s*$/,
    "the branch must not END on a return (#145)",
  );
});

test("a tool row CAN fall back to staleDone when its result is missed (#145)", () => {
  const at = app.indexOf("const staleDone = !props.agentActive && !res;");
  assert.notEqual(at, -1, "the stale-run guard must exist (#40)");
  const block = app.slice(at, at + 200);
  assert.match(
    block,
    /!props\.agentActive && !res/,
    "a row closes when the agent is not live and no result arrived (#40/#145)",
  );
});

test("an orphaned result still renders with its output (#54)", () => {
  // so a result whose call is out of the window is not simply lost
  const at = app.indexOf("const pairInfo = createMemo");
  assert.notEqual(at, -1, "pairInfo must exist (#54)");
  const block = app.slice(at, at + 1200);
  assert.match(block, /orphanCalls\.set\(e\.id, e\)/, "an unpairable result is synthesised (#54)");
});

test("the socket payload is still merged (#54)", () => {
  // the #54 fix must survive: the payload remains the data, it just no longer
  // replaces the feed refresh
  assert.match(
    eventBranch(),
    /mergeEvents\(\[/,
    "the payload must still be inserted directly (#54/#145)",
  );
});
