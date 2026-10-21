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

  // A fixed 3-column grid: auto-fit changed the card's SHAPE with the panel width, so the
  // same six numbers laid out differently while the divider was dragged.
  const grid = cssRuleBody(css, ".rtgrid");
  assert.match(
    grid,
    /repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
    "the grid must be a fixed 3 columns, equal width, and shrinkable (minmax(0,1fr))",
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

test("each runtime cell holds ONE number, because a composite overflows (#ui)", async () => {
  /**
   * Reported twice: `turns 7440/7682` overflowed, then `tokens 202.8m/230k` did.
   *
   * The composite was the cause, not the width. A cell showing "a/b" is as wide as its two
   * halves together, and a long session makes both halves big — `202.8m/230k` is nine
   * characters of digits plus a separator. Eliding it is not a fix: the operator cannot tell
   * which half was clipped.
   *
   * The rule this pins: no runtime value cell may render a composite. One number per cell, and
   * the label says which.
   */
  const app = await readSource("frontend/App.tsx");
  // bound the grid by the NEXT section heading ("🌿 branches"): simple, and it cannot stop
  // inside a cell the way a `</div>` search does
  const gridStart = app.indexOf('class="rtgrid"');
  const gridEnd = app.indexOf("🌿 branches", gridStart);
  assert.ok(gridStart > 0 && gridEnd > gridStart, "precondition: the runtime grid is findable");
  const grid = app.slice(gridStart, gridEnd);

  /**
   * POSITIVE assertion: every value cell renders exactly ONE expression.
   *
   * A `doesNotMatch(/rtsep/)` would be vacuous the moment that class is renamed, and an
   * earlier version of this test passed while the composite was restored (the separator had
   * simply been renamed). What actually distinguishes a composite is TWO interpolations in one
   * `<b>`, so count them.
   */
  const values = [...grid.matchAll(/<b>([\s\S]*?)<\/b>/g)].map((m) => m[1] ?? "");
  assert.ok(values.length >= 4, `precondition: found ${values.length} value cells in the grid`);
  for (const v of values) {
    const interpolations = (v.match(/\{/g) ?? []).length;
    assert.ok(
      interpolations <= 1,
      `a runtime cell renders ${interpolations} values together (${JSON.stringify(v.trim())}) — ` +
        `"a/b" is as wide as both halves and is what overflowed; split it into one cell each`,
    );
  }
  // and the paired facts must still be reachable, just as separate cells
  for (const label of ["tokens in", "tokens out"]) {
    assert.ok(grid.includes(label), `the ${label} cell is missing`);
  }
});
