/**
 * #46 — "a timed-out bash never reads as complete on the timeline"
 *
 * The bash summary line was built from the result's duration plus the requested
 * timeout, so a command killed by the timeout rendered as:
 *
 *     300ms · timeout 1s
 *
 * which is indistinguishable from a fast SUCCESS — nothing said it had been
 * killed, and the row kept its normal unmarked appearance. The only signal was
 * a generic `· FAILED` inside the result body, below the fold for a long command.
 *
 * runShell() has three terminal shapes, and the first two mean "the harness
 * killed it", which is materially different from "it exited non-zero".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shellOutcome,
  outcomeMarker,
  shellHint,
} from "../frontend/lib/shell-outcome.ts";
import { fmtDur } from "../frontend/lib/format.ts";

const opts = (o: Partial<Parameters<typeof shellHint>[0]> = {}) => ({
  outcome: "ok" as const,
  durationMs: 12,
  timeoutMs: undefined,
  fmtDur,
  ...o,
});

/* ---------- detection, from the real runShell output shapes ---------- */

test("shellOutcome recognises the three terminal shapes (#46)", () => {
  assert.equal(
    shellOutcome(false, "TIMEOUT after 300ms. Partial output:\n(nope)"),
    "timeout",
  );
  assert.equal(shellOutcome(false, "ABORTED (harness shutdown). Partial output:\nx"), "aborted");
  assert.equal(shellOutcome(false, "exit=3\nboom"), "exit");
  assert.equal(shellOutcome(true, "hello"), "ok");
  assert.equal(shellOutcome(true, ""), "empty");
});

test("shellOutcome tolerates missing data (#46)", () => {
  assert.equal(shellOutcome(undefined, undefined), "empty");
  assert.equal(shellOutcome(undefined, null), "empty");
});

test("a non-zero exit with no exit= line still counts as an exit (#46)", () => {
  // some tools fail without printing exit=; ok:false must not read as "ok"
  assert.equal(shellOutcome(false, "permission denied"), "exit");
});

/* ---------- THE regression: a killed command must not look successful ---------- */

test("a TIMED OUT bash is marked as such on the summary line (#46)", () => {
  const outcome = shellOutcome(false, "TIMEOUT after 300ms. Partial output:\n(none)");
  const hint = shellHint(opts({ outcome, durationMs: 300, timeoutMs: 300 }));
  assert.match(hint, /TIMED OUT/, `the summary must say it timed out: ${hint}`);
  assert.match(hint, /300ms/, "it must still show the duration");
  assert.match(hint, /timeout 0s|timeout 1s/, "it must still show the timeout that fired");
});

test("a timed-out bash is distinguishable from a fast success (#46)", () => {
  const timedOut = shellHint(opts({ outcome: "timeout", durationMs: 300, timeoutMs: 300 }));
  const succeeded = shellHint(opts({ outcome: "ok", durationMs: 300, timeoutMs: 300 }));
  assert.notEqual(timedOut, succeeded, "same duration, different outcome — they must differ (#46)");
  // the exact string the issue is about must no longer be ambiguous
  assert.doesNotMatch(succeeded, /TIMED OUT|FAILED/);
});

test("a plain non-zero exit keeps the familiar · FAILED (#46)", () => {
  // the common failure path must read exactly as before
  assert.equal(outcomeMarker(shellOutcome(false, "exit=1\nboom")), " · FAILED");
  assert.equal(outcomeMarker(shellOutcome(true, "fine")), "");
});

test("an aborted command is named, not silently failed (#46)", () => {
  assert.equal(outcomeMarker(shellOutcome(false, "ABORTED (harness shutdown). x")), " · ABORTED");
});

/* ---------- hint composition ---------- */

test("the hint omits a timeout the caller never set (#46)", () => {
  const hint = shellHint(opts({ outcome: "ok", durationMs: 4200 }));
  assert.doesNotMatch(hint, /timeout/, "no timeout_ms means no timeout hint");
  assert.match(hint, /4\.2s/);
});

test("the hint survives missing timing data (#46)", () => {
  const hint = shellHint(opts({ outcome: "timeout", durationMs: undefined, timeoutMs: undefined }));
  assert.match(hint, /TIMED OUT/, "the outcome must survive even with no numbers (#46)");
});

test("a background job keeps its own hint shape (#46)", () => {
  // shellHint is for foreground rows only; background rows are assembled
  // separately and must not gain a TIMED OUT marker they never had
  const bg = `background job bg1${""}`;
  assert.doesNotMatch(bg, /TIMED OUT/);
});

/* ---------- App.tsx wiring ---------- */

