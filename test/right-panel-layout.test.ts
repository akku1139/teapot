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

test("the feed DISABLES native scroll anchoring — it fights our own (#ui)", async () => {
  /**
   * This property has now been flipped three times, so this test records the MEASUREMENT that
   * settled it rather than another argument.
   *
   * In headless Firefox, grow a row ABOVE the read position (the real trigger — content changing
   * below the viewport moves nothing) while the composer also grows:
   *
   *     overflow-anchor: auto → scrollTop 4712 → 4785   (+73px — the engine pushed the viewport)
   *     overflow-anchor: none → scrollTop 4712 → 4712   (0)
   *
   * That +73 is the reported "2行以上だと入力時にタイムラインのスクロールが戻る" in Firefox: the
   * engine shifts the viewport, the shift arrives as a normal scroll event, and the follow policy
   * reads it as the READER scrolling away. Chrome does not make the same adjustment here, which is
   * why the symptom has been Firefox-only in both directions.
   *
   * The v0.35.11 note claimed script "cannot replace it" because a correction runs after paint. That
   * is true and beside the point: `resyncAfterUnskip()` re-applies the anchored row's position
   * after layout and `restoreAfterBoxChange()` pins on every box change, so the engine is not the
   * only writer — it is a competing one.
   */
  const css = await readSource("frontend/app.css");
  const feed = cssRuleBody(css, ".feed");
  assert.match(
    feed,
    /overflow-anchor:\s*none/,
    "the feed must opt out: native anchoring moves the viewport and the policy reads it as the reader",
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

test("every feed box change re-pins a follower — measurement included (#scroll)", async () => {
  /**
   * Reported four times, and the first three fixes were wrong in instructive ways:
   *
   *   v0.34.7  guarded the `height: auto` collapse with `contentHeight <= offsetHeight` —
   *            MEASURED always true once the box is sized, so the collapse stayed unconditional.
   *   v0.34.8  compared against a remembered content height, but read it from a box that was
   *            still tall, so the guard never fired and deleting never shrank the box.
   *   v0.34.9  skipped the feed's ResizeObserver entirely while measuring. That removed the
   *            damage from the collapsed layout AND removed the only pin: when the composer
   *            grows, `scrollTop` does not change, so no scroll event fires and this observer is
   *            the sole thing that restores the tail.
   *
   * The collapse is unavoidable (a tall box reports `max(height, content)`), and pinning during
   * it is harmless — `pinToTail()` is `scrollTop = scrollHeight`, which the browser clamps to the
   * floor at that moment, and the next box change pins again. So there is no suppression
   * machinery any more, and this test asserts its absence: a flag that skips the pin is how the
   * bug survived a release.
   */
  const app = await readSource("frontend/App.tsx");
  const obs = app.slice(app.indexOf("const restoreAfterBoxChange = () => {"));
  const obsBody = obs.slice(0, obs.indexOf("\n  };"));

  // the pin sits under `if (atBottom()) { … pinToTail() … }`; assert both parts exist in order
  const followAt = obsBody.indexOf("if (atBottom())");
  assert.ok(followAt > 0, "the observer must consult the follow state");
  const pinAfter = obsBody.indexOf("pinToTail()", followAt);
  assert.ok(
    pinAfter > followAt,
    "a following reader must be re-pinned on every box change — this observer is the only pin " +
      "after a composer grow, because no scroll event fires",
  );
  assert.doesNotMatch(
    obsBody,
    /suppressFeedResize/i,
    "no suppression flag: skipping the pin is exactly what made the bug survive v0.34.9",
  );
  // and the measuring round-trip itself must still exist — it is required, not optional
  const fn = app.slice(app.indexOf("const autosizeComposer = () => {"));
  assert.match(fn.slice(0, fn.indexOf("\n  };")), /style\.height\s*=\s*"auto"/);
});

test("an EMPTY composer is one line, whatever its placeholder wraps to (#ui)", async () => {
  /**
   * Reported: shrink the window, type something, delete it — and the placeholder is left
   * WRAPPED. `scrollHeight` of an empty textarea includes the PLACEHOLDER in Chromium, so a
   * measurement meant to describe the message ends up describing how the placeholder happens to
   * wrap at the current width.
   *
   * A textarea's own `height: auto` is `rows` × line-height — independent of both content and
   * placeholder — so clearing the height is the exact answer for an empty box, and it is the
   * state the composer starts in. Before-typing and after-deleting then agree.
   */
  const app = await readSource("frontend/App.tsx");
  const fn = app.slice(app.indexOf("const autosizeComposer = () => {"));
  const body = fn.slice(0, fn.indexOf("\n  };"));

  assert.match(
    body,
    /if\s*\(\s*!composerEl\.value/,
    "autosizeComposer must special-case an EMPTY box — otherwise the placeholder's wrapping " +
      "decides the height and it stays wrapped after the text is deleted",
  );
  // and the empty branch must clear the height rather than measure the placeholder
  const emptyAt = body.indexOf("!composerEl.value");
  const branch = body.slice(emptyAt, emptyAt + 300);
  assert.match(
    branch,
    /style\.height\s*=\s*""/,
    "the empty branch must CLEAR the height (falling back to `rows`) instead of setting a px value",
  );
});

test("the GOAL card is not height-clipped (#ui)", async () => {
  /**
   * Reported: a four-paragraph goal displayed only up to "…gist.github.com/akk", i.e. cut
   * mid-URL. `.card` carries `max-height: 200px; overflow-y: auto`, which is right for tool
   * output but silently CLIPS a long goal and leaves an inner scrollbar — it reads as the goal
   * having been truncated when it was saved.
   *
   * A CSS contract: `max-height` on a rendered element is not observable through happy-dom (no
   * layout), so the rule itself is what is pinned. Asserted as "no cap" on the class the goal
   * uses, with the base `.card` cap left alone so tool output keeps its bound.
   */
  const css = await readSource("frontend/app.css");
  const base = cssRuleBody(css, ".card");
  assert.match(base, /max-height:\s*200px/, "the base card keeps its bound for tool output");
  const goal = cssRuleBody(css, ".card.goalcard");
  assert.match(goal, /max-height:\s*none/, "the goal card must size to its content");
  assert.match(goal, /overflow-y:\s*visible/, "and must not scroll internally");
});
