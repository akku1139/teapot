/**
 * Right-panel geometry, as a CSS CONTRACT.
 *
 * happy-dom does no layout, so a box measurement here would be 0x0 for every element and
 * assert nothing (that mistake made an earlier theme-preview check report 0x0 WITH the fix in
 * place). The properties that decide whether content escapes its card are declarations, so
 * those are what is pinned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import { cssRuleBody } from "./helpers/css.ts";

test("the runtime stat grid cannot overflow its card (#ui)", async () => {
  const css = await readSource("frontend/app.css");

  /**
   * Reported: `turns 7440/7682` spilled outside its cell.
   *
   * Two declarations make that impossible, and BOTH are needed:
   *   - the cell must be allowed to shrink (`min-width: 0`) — a grid item's default
   *     `min-width: auto` refuses to go below its content, so the track is forced wider than
   *     the card and the row overflows
   *   - the value must be allowed to clip (`overflow: hidden` + ellipsis) — `white-space:
   *     nowrap` alone does not shrink to fit, it just paints outside
   */
  const cell = cssRuleBody(css, ".rtcell");
  assert.match(cell, /min-width:\s*0/, "the cell must be shrinkable or the grid overflows");
  assert.match(cell, /overflow:\s*hidden/, "a long value must clip, not escape");

  const value = cssRuleBody(css, ".rtcell > b");
  assert.match(value, /white-space:\s*nowrap/, "a number must not wrap mid-value");
  assert.match(value, /overflow:\s*hidden/, "…and must clip rather than paint outside the cell");

  // the track has to be wide enough for four digits a side, or every cell elides
  const grid = cssRuleBody(css, ".rtgrid");
  const minmax = grid.match(/minmax\((\d+)px/);
  assert.ok(minmax, "the grid must define a minimum track width");
  assert.ok(
    Number(minmax[1]) >= 80,
    `a minmax of ${minmax[1]}px is narrower than "7440/7682"; the column would elide a real number`,
  );
});

test("every button hashes the same hover language (#ui)", async () => {
  const css = await readSource("frontend/app.css");
  /**
   * Reported: "小さいボタンはhoverでちょっと拡大して、大きいボタンは拡大しないのが一貫性がない".
   *
   * `.iconbtn` (the 24px squares) had `transform: translateY(-1px)` while `.runbtn` and
   * `.btnrow button` only brightened. One header, two hover languages.
   *
   * The rule this pins: a hover must not MOVE a control. Brightness/colour is the cue, because
   * a 1px hop is a large RELATIVE motion on a small control and none at all on a big one — so
   * the transformation can never look consistent across sizes.
   */
  for (const sel of [".iconbtn:hover", ".runbtn:hover", ".btnrow button:hover", ".termtab:hover"]) {
    let body: string;
    try {
      body = cssRuleBody(css, sel);
    } catch {
      continue; // that control may not exist; the point is about the ones that do
    }
    assert.doesNotMatch(
      body,
      /transform:\s*translate/,
      `${sel} moves on hover — hover must not move a control, or the motion differs by size`,
    );
  }
});
