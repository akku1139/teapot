import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * With a wallpaper, EVERY button is transparent — by ONE rule, not a list of classes.
 *
 * The operator asked for this twice, and the second time rejected the design rather than a value:
 * "そのCSS設計は悪い / html[data-bg-image=\"on\"] のときは全buttonに対して透明化を当てるべき /
 * それならいちいち管理しなくて良いよね", and then "元のコードでの設定ウィンドウ外のボタンと同じ仕様を
 * グローバルに持っていくだけ".
 *
 * They are right. The earlier shape was an exception list (`:not(.copybtn, .qopt, …)`), and every
 * attempt at that in this file has needed repair:
 *   - the list version scored (0,4,1), so it beat `.danger` and the stop button lost its red;
 *   - `:where()` fixed the specificity but contributed ZERO, so class fills beat it back —
 *     MEASURED: `+ key` computed `color(srgb … / 0.94)`, an opaque chip on a translucent surface;
 *   - a per-class override pass then had to chase `.iconbtn`, `.btnrow button`, `.modal button:not(…)`.
 *
 * One `!important` on `background-color` states what the MODE means, and nothing has to be maintained.
 *
 * This is a source check because the property is "no button class is special-cased" — a DOM fixture
 * with the handful of buttons we happen to render passes vacuously the moment someone adds another.
 */
const CSS = readFileSync(path.join(import.meta.dirname, "..", "frontend", "app.css"), "utf8");

test("one rule transparent-ises every button in wallpaper mode (#ui)", () => {
  assert.match(
    CSS,
    /html\[data-bg-image="on"\] button \{\s*\n\s*background-color: transparent !important;/,
    "a single blanket rule must exist, with !important so class fills cannot beat it",
  );
});

test("hover puts a faint fill back, in the button's own colour (#ui)", () => {
  // normal = border + text colour; hover = the same PLUS a semi-transparent background
  const hover = CSS.slice(CSS.indexOf('html[data-bg-image="on"] button:hover'));
  assert.match(hover.slice(0, 300), /background-color: color-mix\(in srgb, currentColor 12%, transparent\) !important/,
    "the hover fill must also be !important, or the blanket rule blanks it");
});

test("no per-class exception list is maintained for wallpaper buttons (#ui)", () => {
  /**
   * The blanket rule must not grow a `:not(...)` chain. This is the design the operator rejected, and
   * it fails silently: a class nobody listed keeps its fill, and the only symptom is a screenshot
   * someone has to notice.
   */
  const at = CSS.indexOf('html[data-bg-image="on"] button {');
  assert.ok(at > 0, "precondition: the blanket rule exists");
  const block = CSS.slice(at, CSS.indexOf("}", at));
  assert.doesNotMatch(block, /:not\(/, "the rule must not enumerate exceptions");
  assert.doesNotMatch(block, /:where\(/, "and must not rely on :where(), which loses to class fills");
});
