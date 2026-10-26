import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBody } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

function firstRule(selector: string): string {
  return cssRuleBody(css, selector);
}

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

test("an icon button never stretches inside a flex form (#44)", () => {
  const body = firstRule(".iconbtn");
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

test("the maximised composer stretches its children (why the pin is needed) (#44)", () => {
  const body = firstRule(".composer.maximized form");
  assert.match(
    body,
    /align-items:\s*stretch/,
    "if this ever stops stretching, the guard above is still correct but the test should know",
  );
});

test("the submit and max buttons are pinned too — 📎 now matches them (#44)", () => {
  const body = firstRule(".composer.maximized .maxbtn");
  assert.match(body, /align-self:\s*flex-end/);
  assert.match(
    css,
    /\.composer\.maximized\s+\.maxbtn,\s*\n\s*\.composer\.maximized form > button\[type="submit"\]/,
    "submit must be pinned alongside the max button (#44)",
  );
});

test("icon buttons keep their fixed square-ish size (#44)", () => {
  const body = firstRule(".iconbtn");
  assert.match(body, /width:\s*26px/, "must keep its width (#44)");
  assert.match(body, /height:\s*24px/, "must keep its height (#44)");
});
