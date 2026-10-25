import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * The ✕ thinking readout must never show an epoch-sized number.
 *
 * "thinking 498029h 10m" was reported twice. 498029 hours IS `Date.now()` reinterpreted — i.e. the
 * clock was armed with `startedAt = 0` and `now() - 0` measured from 1970.
 *
 * A `!props.startedAt` sentinel guard was added for exactly this and was not enough, because the
 * failing case is not zero: a clock armed for an EARLIER stretch survives while a stale live bubble
 * keeps it "meaningful", and the elapsed time is then measured from a moment unrelated to what is on
 * screen. The guard has to be on the RESULT.
 */
test("the thinking timer refuses an implausible elapsed time (#131)", () => {
  const src = readSource("frontend/components/code.tsx");
  const at = src.indexOf("export function ThinkingTimer");
  assert.ok(at > 0, "ThinkingTimer must exist");
  const body = src.slice(at, src.indexOf("export function", at + 10));
  assert.match(body, /if \(!props\.startedAt\) return null/, "the 0 sentinel stays guarded (#131)");
  assert.match(
    body,
    /elapsed > [^)]*\*[^)]*\*|\/\/ > a day cannot be one thinking stretch/,
    "an implausible duration must render nothing — a sentinel check alone let an epoch-sized readout " +
      "through when the clock was armed for an earlier stretch (#131)",
  );
});
