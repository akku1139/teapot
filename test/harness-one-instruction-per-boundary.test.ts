import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * #182 — "時々auto-continueとprogress reportが被ることがあるのが微妙".
 *
 * MEASURED across every session log on this machine: 21 occurrences AFTER the #95 fix, all with the
 * same shape — an assistant turn ends, and 15s later two harness prompts are logged 2ms apart:
 *
 *     14:00:35  msg        assistant: "I've reached the point where further work needs you…"
 *     14:00:50  PROMPT     harness: "Continue working toward the current goal…"
 *     14:00:50  PROMPT     harness: "[harness] Please give a brief progress report now…"
 *
 * #95 guarded ONE direction (progress asked → nudge stands down). The reverse was open, and it is
 * the one the ordering produces: the auto-continue nudge is appended at the END of a round, and the
 * NEXT round's turn loop calls `maybeRequestProgress()` before anything else — so the boundary that
 * carries the nudge is also the boundary that asks for a report.
 *
 * Both directions must hold, and the flag must be per-BOUNDARY: clearing it too early re-opens the
 * bug, clearing it too late silences progress reports for the rest of the session.
 */
test("progress stands down when this boundary already carried a nudge (#182)", () => {
  const src = readSource("src/agent/agent.ts");
  const at = src.indexOf("private async maybeRequestProgress");
  assert.ok(at > 0, "maybeRequestProgress must exist");
  const body = src.slice(at, at + 900);
  assert.match(
    body,
    /if \(this\.nudgedAtTurn === this\.stats\.turns\) return;/,
    "a boundary that already injected the auto-continue nudge must not also ask for a report — " +
      "that is the 2ms pair in the logs (#182)",
  );
});

test("the nudge records that the boundary is spoken for (#182)", () => {
  const src = readSource("src/agent/agent.ts");
  const at = src.indexOf("const nudge = isSub");
  assert.ok(at > 0, "the nudge construction must exist");
  const body = src.slice(at, at + 1200);
  assert.match(
    body,
    /this\.nudgedAtTurn = this\.stats\.turns \+ 1/,
    "pushing the nudge must mark the boundary, or the mirror check never fires (#182)",
  );
});

test("the suppression lasts exactly ONE turn (#182)", () => {
  /**
   * A boolean was wrong here and the suite caught it: an auto-continue loop nudges every round, so a
   * flag set at the end of one round suppressed the report at every later boundary and progress
   * reports stopped for the whole session (MEASURED: three progress tests failed). The nudge is
   * consumed by the NEXT turn, so the marker is that turn's number and the comparison is exact.
   */
  const src = readSource("src/agent/agent.ts");
  const m = /private nudgedAtTurn = -1;/.exec(src);
  assert.ok(m, "the marker must be a TURN NUMBER, not a boolean (#182)");
  assert.doesNotMatch(
    src,
    /this\.nudgedThisBoundary/,
    "a per-round boolean suppresses every later boundary in an auto-continue loop (#182)",
  );
});

test("the ORIGINAL direction is still guarded (#95)", () => {
  // the mirror of this fix must not have replaced the existing one
  const src = readSource("src/agent/agent.ts");
  assert.match(
    src,
    /if \(this\.progressRequestedThisRound\) \{/,
    "progress-asked-first must still suppress the nudge (#95)",
  );
});
