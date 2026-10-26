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
  assert.match(body, /100%/, "the composer's contribution must be measured, not guessed (#142)");
  assert.doesNotMatch(body, /56px/, "the fixed 56px stood in for a taller composer (#142)");
});
