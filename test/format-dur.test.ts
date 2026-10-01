/**
 * #24 — "the bash execution time is impossibly hard to read"
 *
 * Tool rows interpolated raw milliseconds, so a seven-minute build rendered as
 * "431113ms · timeout 3300s". fmtDur() is the single formatter now shared by
 * finished rows and by the live elapsed ticker, so a running call and its
 * result can never disagree about how a duration is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fmtDur } from "../frontend/format.ts";

test("fmtDur: the issue's own example becomes readable (#24)", () => {
  // verbatim from the issue report
  assert.equal(fmtDur(431113), "7m 11s");
  assert.notEqual(fmtDur(431113), "431113ms");
});

test("fmtDur: sub-second keeps millisecond precision", () => {
  assert.equal(fmtDur(0), "0ms");
  assert.equal(fmtDur(1), "1ms");
  assert.equal(fmtDur(999), "999ms");
});

test("fmtDur: seconds take over below a minute", () => {
  assert.equal(fmtDur(1_000), "1.0s");
  assert.equal(fmtDur(1_500), "1.5s");
  assert.equal(fmtDur(59_400), "59.4s");
  assert.equal(fmtDur(59_999), "60.0s");
});

test("fmtDur: minutes, dropping a zero seconds part (#24)", () => {
  assert.equal(fmtDur(60_000), "1m");
  assert.equal(fmtDur(86_000), "1m 26s");
  assert.equal(fmtDur(431_113), "7m 11s");
});

test("fmtDur: hours appear only when real", () => {
  assert.equal(fmtDur(3_600_000), "1h");
  assert.equal(fmtDur(5_400_000), "1h 30m");
  assert.equal(fmtDur(43_200_000), "12h");
});

test("fmtDur: missing/garbage input renders '?' like before (#24)", () => {
  assert.equal(fmtDur(undefined), "?");
  assert.equal(fmtDur(null), "?");
  assert.equal(fmtDur(NaN), "?");
  assert.equal(fmtDur(Infinity), "?");
});

test("fmtDur: never emits a raw 'ms' suffix once a second has passed (#24)", () => {
  // the regression in one assertion: anything >= 1s must not read as raw ms
  for (const ms of [1_000, 4_000, 59_999, 60_000, 431_113, 3_600_000, 86_400_000]) {
    assert.doesNotMatch(fmtDur(ms), /ms$/, `${ms} still renders as raw milliseconds`);
  }
});

test("every durationMs render in App.tsx goes through fmtDur (#24)", () => {
  // guards against a new raw `${durationMs}ms` template creeping back in
  const src = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  const bare = [...src.matchAll(/\{\s*(?:e|res)\.[^}]*durationMs\s*\}\s*ms/g)];
  assert.equal(bare.length, 0, `raw ms templates remain: ${bare.map((m) => m[0]).join(", ")}`);
  // and the formatter really is wired into the tool-row meta lines
  const uses = src.match(/fmtDur\(/g) ?? [];
  assert.ok(uses.length >= 8, `expected fmtDur at every render site, found ${uses.length}`);
});