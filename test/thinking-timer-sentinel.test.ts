/**
 * #131 — "while thinking, switch to another session and come back, and for a moment
 * it shows `thinking 497531h 23m`."
 *
 * ## The number is the giveaway
 *
 * `497531h` is `Date.now()` interpreted as a duration — i.e. elapsed time since the
 * **epoch**. So `startedAt` was 0 while `now()` was the real clock.
 *
 * `0` is the sentinel for "the timer was never armed", and it is the state
 * immediately after a session switch: the prune effect zeroes `thinkStartedAt`
 * whenever `agents()` changes, and the first reasoning delta of the newly
 * selected session has not arrived yet. The old readout rendered
 * `now() - props.startedAt` unconditionally, so for those few hundred
 * milliseconds it showed the epoch. Self-correcting, which is exactly the
 * report's "数秒で治る" (fixes itself in seconds).
 *
 * Two fixes, because the epoch flash was a symptom of two defects:
 *
 *  1. `ThinkingTimer` renders nothing while `startedAt` is 0. A sentinel is not a
 *     timestamp, so it must not be subtracted from one.
 *  2. the clock reset on a delta carrying NEITHER text nor reasoning — which
 *     providers send between chunks — so the readout also flickered out
 *     mid-thought. It now resets only when real text arrives.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readSource(path.join(here, "..", "frontend", "App.tsx"));

/* ---------- the readout ---------- */

test("an unarmed timer renders nothing (#131)", () => {
  const at = app.indexOf("function ThinkingTimer");
  assert.notEqual(at, -1, "ThinkingTimer must exist (#131)");
  const body = app.slice(at, app.indexOf("\n}\n", at));
  assert.match(
    body,
    /if \(!props\.startedAt\) return null;/,
    "0 means 'not started' — it must not be subtracted from Date.now() (#131)",
  );
  // and the subtraction only happens after that guard
  const guard = body.indexOf("if (!props.startedAt) return null;");
  const render = body.indexOf("fmtDur(");
  assert.ok(guard !== -1 && render > guard, "the guard must precede the render (#131)");
});

/* ---------- the clock bookkeeping ---------- */

test("the clock resets only when real text arrives (#131)", () => {
  const at = app.indexOf("if (r && !t) {");
  assert.notEqual(at, -1, "the delta bookkeeping must exist (#131)");
  // #126: bound by CODE lines, not comments — my comment quotes the old expression
  // verbatim, so a text search matched the comment rather than the code.
  const block = app
    .slice(at, at + 700)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(
    block,
    /!r && thinkStartedAt\(\)/,
    "a delta with neither text nor reasoning must NOT zero the clock (#131)",
  );
  assert.match(block, /else if \(t\)/, "reset on text alone (#131)");
});

test("a mid-stream delta cannot re-arm the clock (#131)", () => {
  const at = app.indexOf("if (r && !t) {");
  const block = app
    .slice(at, at + 400)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.match(
    block,
    /if \(!thinkStartedAt\(\)\) setThinkStartedAt\(Date\.now\(\)\);/,
    "only the FIRST reasoning chunk arms it (#131)",
  );
});

test("the sweep still zeroes the clock when agents() changes (#131)", () => {
  // this is what leaves it unarmed across a switch — correct behaviour, and the
  // reason the readout must tolerate 0
  const at = app.indexOf("pruneDeadLiveBuffers(prev");
  assert.notEqual(at, -1, "the sweep must exist (#131)");
  const block = app.slice(at, at + 300);
  assert.match(block, /setThinkStartedAt\(0\);/, "the sweep still resets it (#131)");
});
