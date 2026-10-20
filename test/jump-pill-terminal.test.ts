/**
 * #142 — "with the terminal open, the 'jump to present' pill sits on top of it
 * at a fixed offset instead of above it."
 *
 * Two defects, one symptom:
 *
 *  1. `--termh` was published on `.termdrawer`, but the pill lives in the
 *     COMPOSER — a SIBLING. A custom property inherits DOWN the tree, so it
 *     never reached the pill's subtree and every `var(--termh)` there silently
 *     used the hard-coded fallback. Dragging the drawer could not move the pill
 *     at all.
 *  2. the composer's own contribution was a magic 56px. An expanded input is
 *     taller than that, and the composer grows UPWARD, so the pill ended up
 *     under the drawer by exactly the difference.
 *
 * happy-dom does no layout, so the geometry is pinned as a CSS contract (same
 * approach as #44/#57/#65): the offset must be the MEASURED drawer height plus
 * the composer's own height, and `--termh` must be set where both can read it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBodies } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

test("the open-state pill is placed from the drawer height plus the composer's own (#142)", () => {
  const bodies = cssRuleBodies(css, ".channel:has(.termdrawer) .composer:not(.maximized) .jump");
  assert.equal(bodies.length, 1, "exactly one terminal-open rule for the pill (#142)");
  const body = bodies[0]!;
  assert.match(body, /top:\s*auto/, "the base `top` must be cancelled for `bottom` to take effect (#142)");
  assert.match(body, /bottom:\s*calc\(var\(--termh/, "the offset must be the drawer height (#142)");
  // `100%` resolves against the containing block (the composer), so it IS the
  // composer's real height — a constant is what the bug was
  assert.match(body, /100%/, "the composer's contribution must be measured, not guessed (#142)");
  assert.doesNotMatch(body, /56px/, "the fixed 56px stood in for a taller composer (#142)");
});
