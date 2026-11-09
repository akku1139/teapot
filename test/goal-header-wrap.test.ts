/**
 * The goal header must not overflow a narrow details panel.
 *
 * MEASURED from the operator's screenshot (~360px panel): putting auto-continue in the STATUS row overflowed the card. The
 * header is the place with room, but only if it is allowed to WRAP and to shrink — a flex row of nowrap items otherwise
 * pushes the toggle past the right edge, which is the same trap `.chan-head` documents for the channel header.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBody } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

test("the goal header wraps instead of overflowing", () => {
  const head = cssRuleBody(css, ".goalhead");
  assert.match(head, /display:\s*flex/);
  assert.match(head, /flex-wrap:\s*wrap/, "a fourth item must move to a second line, not out of the panel");
  assert.match(head, /min-width:\s*0/, "and the row must be allowed to shrink");
});

test("the auto-continue toggle is a compact inline control", () => {
  const auto = cssRuleBody(css, ".goalauto");
  assert.match(auto, /inline-flex/);
  assert.match(auto, /white-space:\s*nowrap/, "the label itself must not break mid-word");
});
