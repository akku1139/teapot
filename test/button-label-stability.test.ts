/**
 * A button's box must not move when its label changes.
 *
 * MEASURED, headless Firefox: swapping a label from `save settings` to `✓ saved` changes the WIDTH
 * (138px → 100px) and leaves the HEIGHT at 33px, whatever `line-height` says. An earlier note
 * claiming the check mark grew the line box was a guess; it pointed at the wrong property.
 *
 * The visible damage is from width: a shrinking button re-measures its flex line, the siblings
 * re-flow, and the row can wrap — which reads as "the button grew vertically". Reported twice, on
 * the model panel's apply and on the settings save.
 *
 * Both halves are pinned: the global rule stops the label from wrapping or changing the line box,
 * and the per-button `min-width` keeps the width still. Neither alone is enough.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import { cssRuleBody } from "./helpers/css.ts";

test("every button pins its line box, so no glyph can resize it (#ui)", async () => {
  const css = await readSource("frontend/app.css");
  const button = cssRuleBody(css, "button");
  assert.match(button, /line-height:\s*1\b/, "an explicit line-height, not the glyph's metrics");
  assert.match(button, /white-space:\s*nowrap/, "a longer label must not wrap the button");
  assert.match(button, /align-items:\s*center/, "vertical placement comes from the box, not the baseline");
});

test("the save button reserves the width of its WIDEST label (#ui)", async () => {
  /**
   * "save settings" is the widest of the four states ("saving…", "✓ saved", "✕ failed"), so the
   * reserved width must be at least that. MEASURED at 138px in the app's font; 9.5rem = 152px
   * leaves room without looking padded.
   */
  const css = await readSource("frontend/app.css");
  const save = cssRuleBody(css, ".cfgsave");
  const m = /min-width:\s*([\d.]+)rem/.exec(save);
  assert.ok(m, "the save button must reserve a width, or it shrinks on every state change");
  assert.ok(
    Number(m[1]) * 16 >= 140,
    `min-width ${m[1]}rem is less than the 138px measured for "save settings"`,
  );
});
