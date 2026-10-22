/**
 * The composer's height rule.
 *
 * The interesting part is what this function CANNOT do: there is no way to compute the content
 * height of a fixed-height textarea, so the caller must collapse the box first. Three attempts
 * to skip that collapse each shipped a bug, so the round-trip is pinned here as required
 * behaviour rather than treated as an optimisation to be won.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { composerHeight } from "../frontend/composer-size.ts";

const MAX = 360;

test("the box fits its content when the content is within the cap", () => {
  assert.equal(composerHeight(20, MAX), 20, "one line");
  assert.equal(composerHeight(40, MAX), 40, "two lines");
  assert.equal(composerHeight(60, MAX), 60, "three lines");
});

test("past the cap the box stops growing and scrolls instead", () => {
  // without the cap the composer would eat the whole window on a pasted message
  assert.equal(composerHeight(1000, MAX), MAX);
});

test("an empty box never resolves to zero height", () => {
  /**
   * A zero height would collapse the textarea to nothing and look like the composer ate the
   * text. `scrollHeight` is normally at least one line, but the guard is cheap and this is
   * exactly the kind of degenerate input that reaches it via a hidden/measured element.
   */
  assert.equal(composerHeight(0, MAX), 1);
  assert.ok(composerHeight(0, MAX) > 0);
});
