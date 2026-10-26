import { test } from "node:test";
import assert from "node:assert/strict";
import { shellHint, shellOutcome, outcomeMarker } from "../frontend/lib/shell-outcome.ts";
import { fmtDur } from "../frontend/lib/format.ts";
import { BASH_DEFAULT_TIMEOUT_MS as UI_DEFAULT, BASH_MAX_TIMEOUT_MS as UI_MAX, effectiveBashTimeout } from "../frontend/lib/bash-timeout.ts";
import { BASH_DEFAULT_TIMEOUT_MS as SRV_DEFAULT, BASH_MAX_TIMEOUT_MS as SRV_MAX } from "../src/agent/tools.ts";

test("the frontend mirror of the bash timeout matches the server's (#timeout)", () => {
  assert.equal(UI_DEFAULT, SRV_DEFAULT, "the default shown must be the default enforced");
  assert.equal(UI_MAX, SRV_MAX, "and the ceiling too");
});

test("the clamp matches what the server applies to a call (#timeout)", () => {
  assert.equal(effectiveBashTimeout(undefined), SRV_DEFAULT, "omitted → the default");
  assert.equal(effectiveBashTimeout(null), SRV_DEFAULT, "null is omitted");
  assert.equal(effectiveBashTimeout(0), SRV_DEFAULT, "0 is not a usable timeout");
  assert.equal(effectiveBashTimeout(30_000), 30_000, "an explicit value is honoured");
  assert.equal(effectiveBashTimeout(600_000), 600_000, "the ceiling is allowed");
  assert.equal(effectiveBashTimeout(9_000_000), SRV_MAX, "above the ceiling is clamped, not rejected");
  assert.equal(effectiveBashTimeout(-5), SRV_DEFAULT, "a negative value falls back rather than killing instantly");
  assert.equal(effectiveBashTimeout("45000"), 45_000, "a numeric string is what the tool args actually carry");
});

test("an omitted timeout_ms still reports the cap it runs under (#timeout)", () => {
  assert.equal(effectiveBashTimeout(undefined), UI_DEFAULT, "omitted is NOT 'no limit'");

  const hint = shellHint({
    outcome: "ok",
    durationMs: 5_000,
    timeoutMs: effectiveBashTimeout(undefined),
    fmtDur,
  });
  assert.match(hint, /timeout 120s/, `the row must name the default cap (got "${hint}")`);
});

test("the outcome marker is not doubled when the hint joins its parts (#timeout)", () => {
  const hint = shellHint({
    outcome: shellOutcome(false, "TIMEOUT after 120s — killed"),
    durationMs: 120_000,
    timeoutMs: 120_000,
    fmtDur,
  });
  assert.match(hint, /TIMED OUT/, "a killed command must say so");
  assert.doesNotMatch(hint, /·\s*·/, `no doubled separator (got "${hint}")`);
  assert.equal(outcomeMarker(outcomeOf("timeout")), " · TIMED OUT", "rows.tsx renders this with nothing before it");
});

const outcomeOf = (o: "timeout" | "aborted" | "exit"): ReturnType<typeof shellOutcome> =>
  shellOutcome(o === "exit", o === "timeout" ? "TIMEOUT after 1s" : o === "aborted" ? "ABORTED (harness shutdown)" : "exit=1");
