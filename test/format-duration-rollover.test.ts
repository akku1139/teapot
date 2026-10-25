import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtDur } from "../frontend/lib/format.ts";

/**
 * A duration must never contain a unit value of 60.
 *
 * Reported as "2分60秒とは???". `fmtDur` floored the larger unit and rounded the remainder
 * INDEPENDENTLY, so a value just below a boundary rounded up into an impossible number:
 *
 *   59999  -> "60.0s"
 *   119999 -> "1m 60s"
 *   3599999 -> "59m 60s"
 *
 * Driving the WHOLE range rather than the three reported values, because the bug is a boundary
 * class, not three cases: any test that only pins 119999 would pass again the moment the same
 * independent-rounding shape came back one unit down.
 */
test("no duration ever renders a 60 in any unit (#dur)", () => {
  const bad: string[] = [];
  for (let ms = 0; ms <= 7_300_000; ms += 137) {
    const s = fmtDur(ms);
    // "60s", "60m", or a decimals form that rounded to 60 ("60.0s")
    if (/(^|\D)60(\.0)?[sm]/.test(s)) bad.push(`${ms} -> ${s}`);
  }
  assert.deepEqual(bad, [], "a duration with 60 seconds or 60 minutes means the rollover was lost");
});

test("the boundary values round UP into the next unit (#dur)", () => {
  assert.equal(fmtDur(119_999), "2m", "0.001s under two minutes is two minutes");
  assert.equal(fmtDur(3_599_999), "1h", "0.001s under an hour is an hour");
  assert.equal(fmtDur(59_999), "59.9s", "and just under a minute keeps its precision");
});

test("ordinary values are unchanged (#dur)", () => {
  assert.equal(fmtDur(999), "999ms");
  assert.equal(fmtDur(1_000), "1.0s");
  assert.equal(fmtDur(30_500), "30.5s");
  assert.equal(fmtDur(60_000), "1m");
  assert.equal(fmtDur(90_000), "1m 30s");
  assert.equal(fmtDur(3_600_000), "1h");
  assert.equal(fmtDur(3_661_000), "1h 1m");
  assert.equal(fmtDur(undefined), "?");
  assert.equal(fmtDur(null), "?");
});
