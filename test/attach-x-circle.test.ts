import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBody } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

function firstRule(selector: string): string {
  return cssRuleBody(css, selector);
}

const imgx = () => firstRule(".imgchip .imgx");

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

test("the attachment ✕ resets the UA button padding (#57)", () => {
  const body = imgx();
  assert.match(
    body,
    /padding:\s*0/,
    "with the global box-sizing:border-box, the UA button padding is subtracted " +
      "from the declared 16px, so the circle came out undersized (#57)",
  );
  assert.match(body, /width:\s*16px/, "the ✕ keeps its 16px box (#57)");
  assert.match(body, /height:\s*16px/, "the ✕ keeps its 16px box (#57)");
  assert.match(body, /border-radius:\s*50%/, "the ✕ stays round (#57)");
});

test("the attachment ✕ is a positioned overlay, not an inline box (#57)", () => {
  const body = imgx();
  assert.match(body, /position:\s*absolute/, ".imgx stays an overlay (#57)");
  assert.match(body, /top:\s*-5px/, ".imgx keeps its corner overhang (#57)");
  assert.match(body, /right:\s*-5px/, ".imgx keeps its corner overhang (#57)");
});

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
