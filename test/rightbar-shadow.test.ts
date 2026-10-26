/**
 * #53 — "on a narrow screen the right panel leaves a shadow behind even after
 * it is closed — it gets in the way".
 *
 * The drawer is hidden by SLIDING it off-screen (`transform: translateX(100%)`),
 * not by removing it, so it stays in the DOM and still paints. The one part of
 * a fixed, full-height panel that lands inside the viewport while it is
 * translated out of it is its own `box-shadow` — hence a dark sliver clinging
 * to the right edge of the screen after the panel is closed.
 *
 * The fix gates the shadow on the open state. The `transition` carries
 * box-shadow too, so the shadow fades in with the panel rather than snapping.
 *
 * smoke-web.mjs proves this against the real stylesheet at narrow width; this
 * file pins the rule itself so it is still covered when only the wide width
 * runs (where the drawer is a static column and must keep its normal chrome).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

/** the @media (max-width: 1100px) block that turns the bar into a drawer */
function narrowBlock(): string {
  const start = css.indexOf("@media (max-width: 1100px)");
  assert.ok(start !== -1, "the narrow-screen media query must exist (#53)");
  // walk braces to find the block's real end
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error("unterminated media query (#53)");
}

/**
 * The narrow block contains SEVERAL `.rightbar` rules (a `display:block`
 * override, the drawer itself). Pick the one that actually positions the
 * drawer — matching the first would silently assert against the wrong rule.
 */
function drawerRule(): string {
  const all = [...narrowBlock().matchAll(/\.rightbar\s*\{[^}]*\}/g)].map((m) => m[0]);
  const drawer = all.find((r) => /position:\s*fixed/.test(r));
  assert.ok(drawer, `the fixed-position drawer rule must exist in the media query (#53). Saw: ${JSON.stringify(all)}`);
  return drawer!;
}

test("the closed drawer declares NO shadow (#53)", () => {
  const rule = drawerRule();
  assert.match(
    rule,
    /box-shadow:\s*none\s*;/,
    `the closed drawer must declare box-shadow:none — a translated-off-screen element still PAINTS its shadow (#53). Got: ${rule.trim()}`,
  );
  assert.doesNotMatch(
    rule,
    /box-shadow:\s*-8px/,
    "the lift shadow must not be on the closed drawer (#53)",
  );
});

test("the OPEN drawer still casts its shadow (#53)", () => {
  const block = narrowBlock();
  const open = block.match(/\.rightbar\.open\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(open, /\.rightbar\.open\s*\{/, "the open-drawer rule must exist (#53)");
  assert.match(
    open,
    /box-shadow:\s*-8px/,
    `an open drawer must lift off the content with its shadow (#53). Got: ${open.trim()}`,
  );
});

test("the shadow fades in with the panel rather than snapping (#53)", () => {
  const rule = drawerRule();
  assert.match(
    rule,
    /transition:[^;]*box-shadow/,
    `box-shadow must be transitioned so the shadow appears with the drawer (#53). Got: ${rule.trim()}`,
  );
});

test("the wide-screen column keeps its own border, not a floating shadow (#53)", () => {
  // at wide the bar is a static grid column: it must not gain the drawer's
  // fixed shadow, which would be the same "shadow with nothing to close" bug
  const base = css.match(/^\.rightbar\s*\{[^}]*\}/m)?.[0] ?? "";
  assert.match(base, /\.rightbar\s*\{/, "the base .rightbar rule must exist (#53)");
  assert.doesNotMatch(
    base,
    /box-shadow:\s*-8px/,
    "the wide-screen column must not carry the drawer's floating shadow (#53)",
  );
});
