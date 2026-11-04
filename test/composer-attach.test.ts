/**
 * #44 — "the attachment button's emoji isn't centred, and maximising the input
 *         sends the attachment button to the top of the screen (it should keep
 *         the same position as the buttons beside it)"
 *
 * Two distinct CSS defects, both in how `.iconbtn` behaves inside a flex form:
 *
 *  1. `.iconbtn` had no `align-self`, and `.composer.maximized form` sets
 *     `align-items: stretch`. A stretched flex item overrides its height, so
 *     the 📎 button grew into a tall strip and its emoji drifted off-centre.
 *     `.maxbtn` and `button[type=submit]` were already pinned with
 *     `align-self: flex-end` — 📎 was simply missed.
 *  2. `.iconbtn` was not itself a flex container, so the glyph sat on the text
 *     baseline rather than being centred in the button box.
 *
 * happy-dom does no layout, so this pins the CSS contract that governs both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBody } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

/**
 * Body of the FIRST rule whose SELECTOR list contains `selector`.
 *
 * Walks the stylesheet rule by rule so a token appearing in a declaration (or a
 * comment) is never mistaken for a selector.
 */
function firstRule(selector: string): string {
  // #75: delegates to the shared helper so the body has its COMMENTS STRIPPED.
  // The original scanned the stylesheet itself and returned the raw text, so a
  // declaration that lived only inside an explanatory comment satisfied the
  // assertion — commenting out the whole #44/#57 fix still passed.
  return cssRuleBody(css, selector);
}

/* ---------- 1: the emoji is centred in the button ---------- */

test("an icon button centres its glyph (#44)", () => {
  const body = firstRule(".iconbtn");
  assert.match(
    body,
    /display:\s*inline-flex/,
    ".iconbtn must be a flex container or the emoji sits on the text baseline (#44)",
  );
  assert.match(body, /align-items:\s*center/, "glyph must be centred vertically (#44)");
  assert.match(body, /justify-content:\s*center/, "glyph must be centred horizontally (#44)");
});

/* ---------- 2: the button never stretches ---------- */

test("an icon button never stretches inside a flex form (#44)", () => {
  const body = firstRule(".iconbtn");
  // THE regression: `.composer.maximized form` sets `align-items: stretch`, and
  // a stretched item overrides its height — the 📎 button grew into a tall
  // strip instead of staying a square button in the bottom row.
  assert.match(
    body,
    /align-self:\s*flex-end/,
    ".iconbtn must pin itself to the bottom of the row (#44)",
  );
  assert.match(
    body,
    /flex:\s*0 0 auto/,
    ".iconbtn must not grow or shrink with the row (#44)",
  );
});

/* ---------- the maximised composer is the thing that caused it ---------- */

test("the maximised composer stretches its children (why the pin is needed) (#44)", () => {
  const body = firstRule(".composer.maximized form");
  assert.match(
    body,
    /align-items:\s*stretch/,
    "if this ever stops stretching, the guard above is still correct but the test should know",
  );
});

test("the submit and max buttons are pinned too — 📎 now matches them (#44)", () => {
  // the pinned rule's SELECTOR lists both .maxbtn and the submit button; only
  // the declaration itself is in the body
  const body = firstRule(".composer.maximized .maxbtn");
  assert.match(body, /align-self:\s*flex-end/);
  assert.match(
    css,
    /\.composer\.maximized\s+\.maxbtn,\s*\n\s*\.composer\.maximized form > button\[type="submit"\]/,
    "submit must be pinned alongside the max button (#44)",
  );
});

/* ---------- sizing preserved ---------- */

test("one-character buttons are SQUARE (#207)", () => {
  /**
   * "正方形なボタンの縦横の長さを揃える" — a glyph button that is 2px wider than tall reads as lopsided, which is what
   * the ✕ on the terminal tab showed. Both featured sizes are now square.
   */
  const body = firstRule(".iconbtn");
  const w = Number(/width:\s*(\d+)px/.exec(body)?.[1]);
  const h = Number(/height:\s*(\d+)px/.exec(body)?.[1]);
  assert.equal(w, h, `width and height must match, got ${w}x${h}`);
  assert.ok(w >= 24, "and the box must stay a usable click target");
  const tabx = firstRule(".tabx");
  const tw = Number(/width:\s*(\d+)px/.exec(tabx)?.[1]);
  const th = Number(/height:\s*(\d+)px/.exec(tabx)?.[1]);
  assert.equal(tw, th, `the terminal tab's ✕ must be square too, got ${tw}x${th}`);
});
