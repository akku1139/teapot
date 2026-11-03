import assert from "node:assert/strict";
import test from "node:test";
import { shortDuration, turnAnchor } from "../src/agent/timing.ts";

test("shortDuration keeps one unit of resolution and two parts at most", () => {
  assert.equal(shortDuration(0), "0s");
  assert.equal(shortDuration(45_000), "45s");
  assert.equal(shortDuration(90_000), "2m");
  assert.equal(shortDuration(12 * 60_000), "12m");
  assert.equal(shortDuration(72 * 60_000), "1h12m");
  assert.equal(shortDuration(3 * 3600_000), "3h");
  assert.equal(shortDuration(50 * 3600_000), "2d2h");
  assert.equal(shortDuration(-5), "0s", "a negative span is nonsense, not a negative duration");
});

test("the anchor says what time it is, how long the session has run, and the gap", () => {
  /**
   * "AIが時間把握するのが極めて下手" — the model narrated a five minute exploit and a device reboot as if no time
   * had passed, because nothing in the transcript carried a clock.
   */
  const startedAt = new Date("2026-05-01T10:00:00").toISOString();
  const now = new Date("2026-05-01T11:12:00").getTime();
  const line = turnAnchor({ now, startedAt, lastTurnAt: now - 3 * 60_000 });
  assert.match(line, /^\[harness\] now \d\d:\d\d · 1h12m into this session · 3m since the last turn$/);
});

test("missing or unparseable parts are dropped, never rendered as NaN", () => {
  const now = Date.now();
  assert.doesNotMatch(turnAnchor({ now }), /NaN|undefined/);
  assert.doesNotMatch(turnAnchor({ now, startedAt: "not a date" }), /NaN/);
  // a gap under a few seconds is noise and must not appear
  assert.doesNotMatch(turnAnchor({ now, lastTurnAt: now - 500 }), /since the last turn/);
  // a clock skew that puts the session start in the future must not print a negative age
  assert.doesNotMatch(turnAnchor({ now, startedAt: new Date(now + 60_000).toISOString() }), /-/);
});
