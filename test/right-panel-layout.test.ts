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
import { cssRuleBodies, cssRuleBody } from "./helpers/css.ts";

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

test("a grouped row sits at the SAME x as its head row (#ui)", async () => {
  /**
   * Reported: "グループ化されたtoolの2つ目以降が微妙に右にズレてる".
   *
   * `.msg` carries `padding: var(--space-6)` horizontally (16px), but `.msg.grouped` overrode
   * it with a LITERAL `18px` — so every continuation row sat 2px right of the row it continues.
   * Two declarations that must agree, written as one token and one magic number, is exactly how
   * that drifts.
   *
   * The contract: a grouped row must not introduce a horizontal padding of its own. Any value
   * is allowed as long as it is the SAME expression `.msg` uses.
   */
  const css = await readSource("frontend/app.css");
  // `.msg` appears in SEVERAL rules (a base one, then `--grouped-gap`, then hover states), and
  // `cssRuleBody` returns the last match — which is not the one that declares the padding. Take
  // the rule that actually sets a full `padding`, which is the one the rows inherit.
  // match `padding:` but NOT `padding-top:` — a plain `\b` would let the latter through
  const fullPad = (body: string) => body.match(/(?:^|[;\s])padding:\s*([^;]+);/)?.[1]?.trim();
  const basePad =
    cssRuleBodies(css, ".msg")
      .map(fullPad)
      .find((v) => v && v.split(/\s+/).length >= 2) ?? "";
  assert.ok(basePad, "precondition: .msg declares a horizontal padding");

  for (const sel of [".msg.grouped"]) {
    for (const body of cssRuleBodies(css, sel)) {
      const pad = fullPad(body);
      if (!pad) continue; // only padding-top etc — no horizontal claim
      /**
       * Compare the HORIZONTAL component only.
       *
       * A grouped row legitimately drops the top padding (`0 <h>`) — that is what makes a run
       * read as one block. What must not differ is the horizontal value, which is what decides
       * x. The shorthand's 2nd/4th value is the horizontal one.
       */
      // CSS shorthand: 1 value = all sides, 2 = vertical/horizontal, 3 = top/horiz/bottom,
      // 4 = top/right/bottom/left. The horizontal side is the 2nd when there is one, else 1st.
      const horiz = (v: string) => {
        const p = v.split(/\s+/);
        return p.length >= 2 ? p[1]! : p[0]!;
      };
      const horizontal = horiz(pad);
      const baseHorizontal = horiz(basePad);
      assert.equal(
        horizontal,
        baseHorizontal,
        `${sel} sets its own horizontal padding (${horizontal}) while .msg uses ` +
          `(${baseHorizontal}); a continuation row must line up with its head row`,
      );
    }
  }
});

test("the feed opts OUT of native scroll anchoring, or Firefox moves it behind our back (#ui)", async () => {
  /**
   * Reported as a FIREFOX-ONLY bug: "入力枠拡大時に入力すると非拡大時の高さに合わせてスクロールが
   * 戻る", while Chrome was fine.
   *
   * Browser scroll anchoring adjusts `scrollTop` to keep an anchor element in place when content
   * above changes size. Firefox applies it when the COMPOSER resizes, so typing into a
   * multi-line box moved `scrollTop` by the composer's own growth — with no reader input. That
   * arrives as an ordinary scroll event, so the feed's policy read it as the reader pulling the
   * timeline up and dropped follow. Chrome's anchoring is conservative enough there that the
   * same code looked correct, which is why it reproduced in one browser only.
   *
   * teapot does its own anchoring (anchor restore when reading, re-pin when following), so the
   * native one is pure interference.
   */
  const css = await readSource("frontend/app.css");
  const feed = cssRuleBody(css, ".feed");
  assert.match(
    feed,
    /overflow-anchor:\s*none/,
    "the feed must disable native scroll anchoring — our policy owns the scroll position",
  );
});

test("creating or selecting a theme ADOPTS it, or every edit is invisible (#ui)", async () => {
  /**
   * Reported: "choose image… で画像選択したのに何も変わらない".
   *
   * `applyCustomTheme()` paints only the ACTIVE theme. `duplicatePreset()` created an editable
   * copy and `setEditingId()`'d it but never called `onPick`, so the copy was editable and
   * inert: changing a colour or picking a background image reached the store and never the
   * screen. The theme SELECTOR had the same flaw.
   *
   * Asserted on the wiring, because the failure is silent — there is no error and no visible
   * symptom other than "nothing happens", which is exactly why it shipped twice.
   */
  const app = await readSource("frontend/App.tsx");
  const dup = app.slice(app.indexOf("const duplicatePreset ="));
  const dupBody = dup.slice(0, dup.indexOf("\n  };"));
  assert.match(
    dupBody,
    /props\.onPick\(id\)/,
    "duplicating a theme must ADOPT it — an editable copy that is not active shows no changes",
  );

  // the picker's onchange lives INSIDE the <select> that carries that title, and the title is
  // the LAST attribute — so slice the element from its opening tag to its close, not forward
  // from the title (which would miss the handler)
  const titleAt = app.indexOf('title="which custom theme to edit');
  assert.ok(titleAt > 0, "precondition: the theme picker exists");
  const selectOpen = app.lastIndexOf("<select", titleAt);
  const picker = app.slice(selectOpen, app.indexOf("</select>", titleAt));
  assert.match(
    picker,
    /props\.onPick\(/,
    "selecting a theme to edit must apply it, for the same reason",
  );
});
