/**
 * When the composer re-measures itself — and why it must NOT most of the time.
 *
 * Reported twice, in two browsers: "2行以上の入力欄に入力するとタイムラインのスクロールが1行目の
 * 高さに合わせて戻る". The engine was never the variable; the round-trip was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsRemeasure } from "../frontend/composer-size.ts";

/** one line is ~20px, so these are 1, 2 and 3 line contents */
const L1 = 20;
const L2 = 40;
const L3 = 60;

test("GROWING the composer must not re-measure (#scroll)", () => {
  /**
   * Typing a second line: the box is still at one line's height, so `scrollHeight` already
   * reports the two-line content. Collapsing to `auto` would lay the box out at one line,
   * grow `.feed` by the difference, and the follow logic re-pins to the one-line floor —
   * the reported drift, exactly one line's worth.
   */
  assert.equal(needsRemeasure(L2, L1, false), false, "a grown box needs no measurement");
  assert.equal(needsRemeasure(L3, L2, false), false, "and neither does the third line");
  // the case behind "2行は問題ない": the first line never grew, so nothing moved
  assert.equal(needsRemeasure(L1, L1, false), false, "unchanged content needs no measurement");
});

test("SHRINKING the composer must re-measure (#scroll)", () => {
  /**
   * Deleting text is the one case where the box may be taller than its content, and there
   * `scrollHeight` reports the BOX, not the content — so the collapse is the only way to find
   * out how tall the content really is.
   */
  assert.equal(needsRemeasure(L1, L3, false), true, "deleting two lines must shrink the box");
  assert.equal(needsRemeasure(L2, L3, false), true);
});

test("a sub-pixel difference is rounding, not a shrink (#scroll)", () => {
  /**
   * Fractional line heights make `scrollHeight` wobble by a fraction on ratio scaling. Treating
   * that as a shrink would collapse the box on nearly every keystroke — reintroducing the very
   * layout thrash this guard exists to prevent, just below the threshold of being visible.
   */
  assert.equal(needsRemeasure(40, 40.4, false), false);
  assert.equal(needsRemeasure(40.2, 40, false), false);
});

test("a MAXIMIZED box always re-measures (#scroll)", () => {
  // maximising sets a height unrelated to the content, so the remembered content height says
  // nothing about what the box should be when it is released
  assert.equal(needsRemeasure(L1, L1, true), true);
  assert.equal(needsRemeasure(L3, L3, true), true);
});
