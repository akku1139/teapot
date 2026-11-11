/**
 * "clear all" in the notification header is a real button, the same height as the ✕ beside it (#254).
 *
 * "通知の clear all ボタンのかたちが違う / 高さ保証すべき" — it used class `editbtn`, whose only rule was
 * `.msg-head .editbtn` (the message row's inline affordance). In the notification header that selector does not match, so the
 * browser drew a default button: its own padding, its own height, and it sat unevenly next to the 26px icon button.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBody } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

test("the notification clear-all button has a guaranteed height", () => {
  const body = cssRuleBody(css, ".notifhead .editbtn");
  assert.match(body, /height:\s*26px/, "the neighbour is a 26px .iconbtn; a different height reads as broken");
  assert.match(body, /align-items:\s*center/, "the glyph must be centred, not on the text baseline");
  assert.match(body, /background:/, "and it must not fall back to the UA button chrome");
});
