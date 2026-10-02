/**
 * #57 — "the attachment (staged image) ✕ button's circle is broken."
 *
 * The ✕ that unstages a pending image is a 16px red circle in the top-right
 * corner of a 64px thumbnail. Three independent CSS defects made it read as a
 * broken/misplaced shape rather than a round button:
 *
 *  1. NO FLEX CENTRING. The rule set `line-height: 1` on a 9px glyph, which
 *     parks the character on the text baseline inside a 16px box — the ✕ sits
 *     high and left of the circle's centre. This is the identical trap
 *     `.iconbtn` fell into in #44, and the same fix (flex-centre the glyph)
 *     applies.
 *  2. UA BUTTON PADDING. Nothing reset it, and the stylesheet sets
 *     `* { box-sizing: border-box }`, so the default padding is subtracted
 *     from the declared 16×16: the painted circle was smaller than its box and
 *     the glyph was pushed further off-centre still.
 * happy-dom performs no layout, so these tests pin the CSS CONTRACT that
 * governs the geometry (the same approach as test/composer-attach.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/** Body of the FIRST rule whose SELECTOR list contains `selector`. */
function firstRule(selector: string): string {
  let i = 0;
  for (;;) {
    const open = css.indexOf("{", i);
    if (open === -1) throw new Error(`no rule with selector ${selector}`);
    const prevClose = css.lastIndexOf("}", open);
    const selStart = prevClose === -1 ? 0 : prevClose + 1;
    let depth = 0;
    let close = -1;
    for (let j = open; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close === -1) throw new Error(`unterminated rule at ${open}`);
    const sel = css.slice(selStart, open);
    if (sel.includes(selector)) return css.slice(open + 1, close);
    i = close + 1;
  }
}

const imgx = () => firstRule(".imgchip .imgx");

/* ---------- 1: the glyph is centred in the circle ---------- */

test("the attachment ✕ centres its glyph in the circle (#57)", () => {
  const body = imgx();
  assert.match(
    body,
    /display:\s*inline-flex/,
    ".imgx must be a flex container or the ✕ sits on the text baseline (#57)",
  );
  assert.match(body, /align-items:\s*center/, "glyph must be centred vertically (#57)");
  assert.match(body, /justify-content:\s*center/, "glyph must be centred horizontally (#57)");
});

/* ---------- 2: the UA padding cannot shrink the circle ---------- */

test("the attachment ✕ resets the UA button padding (#57)", () => {
  const body = imgx();
  assert.match(
    body,
    /padding:\s*0/,
    "with the global box-sizing:border-box, the UA button padding is subtracted " +
      "from the declared 16px, so the circle came out undersized (#57)",
  );
  // the circle itself must still be a circle at its stated size
  assert.match(body, /width:\s*16px/, "the ✕ keeps its 16px box (#57)");
  assert.match(body, /height:\s*16px/, "the ✕ keeps its 16px box (#57)");
  assert.match(body, /border-radius:\s*50%/, "the ✕ stays round (#57)");
});

/* ---------- 3: the circle is still a positioned overlay ---------- */

test("the attachment ✕ is a positioned overlay, not an inline box (#57)", () => {
  const body = imgx();
  // The <img> here is NOT positioned, so an absolutely-positioned button
  // already paints above it regardless of DOM order — that part was fine.
  // What matters is that the button stays an OVERLAY at all: if `position`
  // were dropped, the ✕ would lay out inline after the thumbnail and push it
  // out of the 64px chip instead of hanging off its corner.
  assert.match(body, /position:\s*absolute/, ".imgx stays an overlay (#57)");
  assert.match(body, /top:\s*-5px/, ".imgx keeps its corner overhang (#57)");
  assert.match(body, /right:\s*-5px/, ".imgx keeps its corner overhang (#57)");
});

/* ---------- the chip must not clip the overlay it positions ---------- */

test("the image chip does not clip the ✕ that overhangs its corner (#57)", () => {
  const chip = firstRule(".imgchip");
  assert.doesNotMatch(
    chip,
    /overflow:\s*hidden/,
    "the ✕ is deliberately offset -5px outside the chip; clipping it would " +
      "cut the circle in half (#57)",
  );
  assert.match(chip, /position:\s*relative/, "the chip must be the ✕'s positioning context (#57)");
});

/* ---------- wiring: the ✕ really is the staged-image control ---------- */

test("the ✕ rendered for a staged image uses .imgx (#57)", () => {
  const idx = app.indexOf("imgchip");
  assert.notEqual(idx, -1, "the staged-image chip must exist (#57)");
  const window = app.slice(idx, idx + 1200);
  assert.match(
    window,
    /class="imgx"/,
    "the staged-image ✕ must carry .imgx (#57)",
  );
  const btn = window.indexOf('class="imgx"');
  const img = window.indexOf("<img");
  assert.ok(
    btn !== -1 && img !== -1,
    "both the thumbnail and its ✕ must be inside the chip (#57)",
  );
});
