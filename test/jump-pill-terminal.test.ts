/**
 * #142 — "with the terminal open, the 'jump to present' pill is not placed
 * above the terminal; it sits on top of it at a fixed offset."
 *
 * Two defects, one symptom:
 *
 *  1. `--termh` was published on `.termdrawer`, but the pill lives in the
 *     COMPOSER — a SIBLING of the drawer. A custom property inherits down the
 *     tree, so it never reached the pill's subtree and every `var(--termh)`
 *     there silently used its hard-coded fallback. The pill therefore could
 *     not track the drawer AT ALL; dragging the drawer did nothing.
 *  2. the composer's own contribution was a magic 56px. An expanded input (or
 *     the hint line) is taller than that, and it grows the composer UPWARD —
 *     so the pill ended up under the drawer by exactly the difference.
 *
 * The fix moves the variable to `.channel` (an ancestor of BOTH) and drops the
 * guess: `100%` in the pill's `bottom` resolves against its containing block
 * (the composer), which is the composer's real height.
 *
 * happy-dom does no layout, so the geometry is pinned as a CSS contract, the
 * same way #44/#57/#65 were.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBodies } from "./helpers/css.ts";
import { readSource } from "./helpers/source.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
const app = readSource(new URL("../frontend/App.tsx", import.meta.url).pathname);

/** the terminal-open override for the pill */
function openRule(): string {
  const bodies = cssRuleBodies(css, ".channel:has(.termdrawer) .composer:not(.maximized) .jump");
  assert.equal(bodies.length, 1, "exactly one terminal-open rule for the pill (#142)");
  return bodies[0]!;
}

test("the pill is placed from the drawer's real height (#142)", () => {
  const body = openRule();
  assert.match(body, /bottom:\s*calc\(/, "the open-state pill must offset by the drawer height (#142)");
  assert.match(body, /var\(--termh/, "and the offset must be the measured drawer height (#142)");
  // NOT a fixed pixel offset: that is the whole bug
  assert.doesNotMatch(
    body,
    /bottom:\s*calc\([^)]*\)?\s*\+?\s*56px/,
    "a fixed 56px stood in for the composer, which is taller than that (#142)",
  );
  assert.doesNotMatch(body, /^\s*top:\s*-?\d/m, "the pill must not be left hanging above the composer (#142)");
  assert.match(body, /top:\s*auto/, "the base `top` must be cancelled for a `bottom` to take effect (#142)");
});

test("the composer's own height is measured, not guessed (#142)", () => {
  // `bottom` is resolved against the containing block — the composer, whose
  // top edge is the drawer's bottom edge — so 100% IS the composer height
  const body = openRule();
  assert.match(
    body,
    /100%/,
    "the composer's contribution must be its OWN height, not a constant (#142)",
  );
});

test("--termh is published where BOTH the drawer and the composer inherit it (#142)", () => {
  // the bug was scope: set on .termdrawer it never reached the pill
  assert.match(
    app,
    /<section class="channel" style=\{\{ "--termh": `\$\{termHeight\(\)\}px` \} as any\}>/,
    "--termh must be set on .channel, the common ancestor of drawer and composer (#142)",
  );
  assert.doesNotMatch(
    app,
    /<div class="termdrawer" style=\{\{ height: `\$\{termHeight\(\)\}px`, "--termh"/,
    "--termh on .termdrawer cannot reach the composer — that was the bug (#142)",
  );
});

test("the pill still lives inside the composer, which is what makes 100% meaningful (#142)", () => {
  const composer = app.slice(app.indexOf('<div class={"composer"'));
  const pill = composer.indexOf('class="jump"');
  const close = composer.indexOf("</div>", pill);
  assert.notEqual(pill, -1, "the pill must be rendered by the composer (#142)");
  assert.ok(close > pill, "and inside it, so the composer is its containing block (#142)");
  // the maximized composer overlays the column and has no feed edge above it,
  // so it needs its own placement or the base `top: -34px` (cancelled) leaves
  // it nowhere
  const max = cssRuleBodies(css, ".channel:has(.termdrawer) div.composer.maximized .jump");
  assert.equal(max.length, 1, "the maximized composer needs its own pill placement (#142)");
  assert.match(max[0]!, /(top|bottom):/, "and that placement must pin it to an edge (#142)");
});
