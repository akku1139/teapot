/**
 * The details panel is a STATIC COLUMN on a wide screen, but on a narrow one
 * (≤1100px) `.rightbar` turns into a fixed drawer that slides in over the
 * content — see the `@media (max-width: 1100px)` block in app.css.
 *
 * In that floating mode the panel had no way out:
 *
 *  1. the ONLY toggle was the ▤ button in the channel header, which the drawer
 *     (position:fixed, z-index:5, up to 92vw wide) covers completely — so
 *     opening it trapped you behind it;
 *  2. there was no backdrop, so no click-outside dismissal;
 *  3. Escape appeared to work, but only by accident: the keydown handler
 *     handled the running-agent interrupt FIRST, so while an agent was working
 *     Escape stopped the AGENT and left the drawer open — and on an idle agent
 *     it closed a drawer the operator could not see how to reopen.
 *
 * happy-dom does no layout, so the visible outcome is pinned as two contracts:
 * the markup must carry a close affordance that lives INSIDE the drawer, and
 * the Escape branch must be reachable before the interrupt branch. The
 * end-to-end behaviour is exercised in scripts/smoke-web.mjs, which renders the
 * real bundle and drives the drawer open and shut.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

/** the body of the `@media (max-width: 1100px)` block, braces balanced */
function narrowBlock(): string {
  const start = css.indexOf("@media (max-width: 1100px)");
  assert.notEqual(start, -1, "app.css must keep the narrow-screen media query");
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error("unterminated @media (max-width: 1100px) block");
}

/** body of the first rule whose selector list mentions `token` */
function ruleBody(token: string): string {
  let i = 0;
  for (;;) {
    const open = css.indexOf("{", i);
    if (open === -1) throw new Error(`no rule mentioning ${token}`);
    const prevClose = css.lastIndexOf("}", open);
    const selStart = prevClose === -1 ? 0 : prevClose + 1;
    let depth = 0;
    let close = -1;
    for (let j = open; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) { close = j; break; }
      }
    }
    if (close === -1) throw new Error("unterminated rule");
    if (css.slice(selStart, open).includes(token)) return css.slice(open + 1, close);
    i = close + 1;
  }
}

/**
 * Like `ruleBody`, but skips rules nested inside an @media block.
 *
 * Needed because the narrow media query comes FIRST in the file and now carries
 * a `.rightbarhead` rule of its own (position/z-index). Without this, asking for
 * "the .rightbarhead rule" silently returns the media-query one and every
 * assertion about the base styling fails on correct code.
 */
function baseRuleBody(token: string): string {
  let i = 0;
  for (;;) {
    const open = css.indexOf("{", i);
    if (open === -1) throw new Error(`no rule mentioning ${token}`);
    const prevClose = css.lastIndexOf("}", open);
    const selStart = prevClose === -1 ? 0 : prevClose + 1;
    let depth = 0;
    let close = -1;
    for (let j = open; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) { close = j; break; }
      }
    }
    if (close === -1) throw new Error("unterminated rule");
    // skip anything whose selector line sits inside braces (i.e. inside @media)
    const before = css.slice(0, open);
    const mediaDepth = (before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0);
    // …and strip comments: the CSS explains the layout in prose, and a
    // `.rightbarhead` MENTIONED in a comment would otherwise match as though it
    // were a selector — returning the neighbouring .rightbarbackdrop rule.
    const sel = css.slice(selStart, open).replace(/\/\*[\s\S]*?\*\//g, "");
    if (sel.includes(token) && mediaDepth === 0) return css.slice(open + 1, close);
    i = close + 1;
  }
}

/* ---------- 1: the ✕ row is the panel's own sticky header ---------- */

test("the ✕ row is STICKY — the panel scrolls, the close button must not (#50)", () => {
  // THE regression: .rightbar is overflow-y:auto with a long body (session,
  // runtime, files, tasks…). A close button that merely sits at the top scrolls
  // out of reach, which is the original bug one scroll away from returning.
  const narrow = narrowBlock();
  assert.match(
    narrow,
    /\.rightbar \.rightbarhead\s*\{[^}]*position:\s*sticky/,
    "the ✕ row must be sticky inside the scrolling panel (#50)",
  );
  assert.match(
    narrow,
    /\.rightbar \.rightbarhead\s*\{[^}]*top:\s*0/,
    "sticky with no top offset pins to the wrong edge (#50)",
  );
  // sticky lets later content scroll underneath, so the row must be opaque.
  // BASE rule: the narrow media query comes first in the file and also has a
  // .rightbarhead rule, so ruleBody() would hand back the wrong one.
  const base = baseRuleBody(".rightbarhead");
  assert.match(
    base,
    /background:\s*var\(--bg-dark\)/,
    "a sticky row without a background shows the panel's text through the ✕ (#50)",
  );
  assert.match(
    base,
    /border-bottom:\s*1px solid var\(--line\)/,
    "content scrolling under a bare row reads as broken (#50)",
  );
  /**
   * …and it must reach the panel's top edge — but the inset comes from the PANEL, not a negative
   * margin on the row.
   *
   * This asserted `margin: -14px -14px 0`. A negative margin does not pull a STICKY box up: the
   * element is pinned by its sticky position, so the panel's 14px of top padding stayed above the
   * row and showed as a band of empty panel — MEASURED as `panelTop=0 headTop=14 gap=14` with
   * `margin-top: -14px` computed. The row now has `margin: 0` and the PANEL drops its top padding
   * (`.rightbar:has(.rightbarhead) { padding-top: 0 }`), which makes the row the top edge for real.
   */
  assert.match(
    base,
    /margin:\s*0;/,
    "no negative margin on the row — it cannot move a sticky box, and it left a 14px gap (#50)",
  );
  const narrow2 = narrowBlock();
  assert.match(
    narrow2,
    /\.rightbar:has\(\.rightbarhead\)\s*\{[^}]*padding-top:\s*0/,
    "the PANEL must drop its top padding so the sticky row is flush with the top edge (#50)",
  );
});

test("the close row only shows on a narrow screen (#50)", () => {
  // a static column has no need for a ✕ row — showing one on a wide screen
  // would add a dead control above the session card.
  assert.match(
    baseRuleBody(".rightbarhead"),
    /display:\s*none/,
    "the ✕ row must be hidden by default (wide screens keep the ▤ toggle)",
  );
  assert.match(
    narrowBlock(),
    /\.rightbar \.rightbarhead\s*\{[^}]*position:\s*sticky/,
    "the narrow media query is what makes it a real, visible row (#50)",
  );
});

test("the drawer is ONE fixed box again (#50)", () => {
  // The ✕ used to be a sibling, so the drawer was two stacked fixed boxes and
  // their heights had to be coupled (--rightbarhead-h) or the panel overlapped
  // the row. Inside the panel there is nothing to couple: the row is a child.
  const narrow = narrowBlock();
  assert.match(
    narrow,
    /\.rightbar\s*\{[^}]*position:\s*fixed[^}]*top:\s*0/,
    "the panel must be flush to the top of the screen (#50)",
  );
  // strip comments first: the CSS explains what this variable USED to be, and a
  // mention in prose is not a live declaration
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/--rightbarhead-h\s*:/.test(cssNoComments),
    "the two-box height coupling must be gone now that the ✕ is inside the panel (#50)",
  );
  assert.match(
    narrow,
    /\.rightbar \.rightbarhead\s*\{[^}]*position:\s*sticky[^}]*\}/,
    "…replaced by a sticky child of that one box (#50)",
  );
});

/* ---------- 1a: the panel's first heading must stay flush ---------- */

test("the panel's first heading keeps margin-top:0 (#50)", () => {
  // THE regression: `.rightbar h3:first-child { margin-top: 0 }` pulled the
  // session heading flush against the panel's top edge. Moving the ✕ row INSIDE
  // .rightbar made it the first child, so `:first-child` stopped matching and
  // the heading silently gained a 14px gap under the ✕ bar — a layout change
  // caused by a control being added, on a screen where nobody was looking for it.
  assert.match(
    baseRuleBody(".rightbar h3:first-of-type"),
    /margin-top:\s*0/,
    "the first section heading must stay flush (#50)",
  );
  assert.ok(
    !/\.rightbar h3:first-child/.test(css),
    ":first-child stops matching once the ✕ row is the panel's first child (#50)",
  );
});

/* ---------- 1b: the row must actually be VISIBLE ---------- */

test("the close row is VISIBLE on a narrow screen, not merely present (#50)", () => {
  // THE regression: the base rule is `display: none` (hidden on a wide screen),
  // so the narrow media query must set `display` back. Collapsing the two rules
  // and keeping only `position: sticky` left the row at display:none — the x
  // existed, sat inside the panel, was sticky, and was COMPLETELY INVISIBLE.
  // happy-dom never re-evaluates media queries, so no runtime check can catch
  // this; it has to be asserted here or not at all.
  const narrow = narrowBlock();
  // selector is scoped (.rightbar .rightbarhead) so it outranks the base rule
  const row = narrow.match(/^\s*\.rightbar \.rightbarhead\s*\{[^}]*\}/m)?.[0] ?? "";
  assert.notEqual(row, "", "the narrow .rightbarhead rule must exist (#50)");
  assert.match(
    row,
    /display:\s*flex/,
    "the narrow query must set display:flex — the base rule is display:none, so " +
      "without this the close button renders invisible (#50)",
  );
  assert.match(
    ruleBody(".rightbarhead"),
    /display:\s*none/,
    "…and the base rule must still hide it on a wide screen (#50)",
  );
});

/* ---------- 1c: narrow rules must OUT-SPECIFY their base rules ---------- */

test("narrow-only rules out-specify their base counterparts (#50)", () => {
  // THE regression, and the subtlest one yet. The Vite minifier HOISTS AND
  // INLINES rules out of the media query, placing them near the top of the
  // bundle. A narrow rule with the SAME specificity as its base rule therefore
  // loses the cascade at equal specificity regardless of source order — the
  // base `.rightbarhead { display: none }` came after it and won, so the ✕ was
  // invisible at EVERY width, narrow included. Scoping the narrow rules to a
  // descendant selector raises specificity above the base rule, so the build
  // can no longer reorder them into a no-op.
  const narrow = narrowBlock();
  assert.match(
    narrow,
    /\.rightbar \.rightbarhead\s*\{/,
    "the narrow ✕ rule must be scoped (.rightbar .rightbarhead) to outrank the base rule (#50)",
  );
  assert.match(
    narrow,
    /\.layout \.rightbarbackdrop\s*\{/,
    "the narrow backdrop rule must be scoped (.layout .rightbarbackdrop) to outrank the base rule (#50)",
  );
  // …and no bare-class narrow rule may survive for these two
  assert.ok(
    !/^\s*\.rightbarhead\s*\{/m.test(narrow),
    "a bare .rightbarhead in the media query loses the cascade after minification (#50)",
  );
  assert.ok(
    !/^\s*\.rightbarbackdrop\s*\{/m.test(narrow),
    "a bare .rightbarbackdrop in the media query loses the cascade after minification (#50)",
  );
});

/* ---------- 2: the backdrop's own CSS ---------- */

test("the backdrop sits under the drawer and over the content (#50)", () => {
  assert.match(
    ruleBody(".rightbarbackdrop"),
    /z-index:\s*4/,
    "below .rightbar's z-index:5, otherwise it swallows the drawer's own clicks",
  );
  assert.match(
    narrowBlock(),
    /\.rightbar\s*\{[^}]*z-index:\s*5/,
    "the drawer must stay above its own backdrop (#50)",
  );
  // The ✕ row is now INSIDE .rightbar (a stacking context at z-index:5), so it
  // no longer needs a global z-index above the backdrop — it only has to sit
  // above the panel's own scrolling content.
  assert.match(
    narrowBlock(),
    /\.rightbarhead\s*\{[^}]*z-index:\s*1/,
    "the sticky ✕ row must out-stack the content that scrolls under it (#50)",
  );
  assert.match(
    ruleBody(".rightbarbackdrop"),
    /display:\s*none/,
    "a click-catcher around a static column would swallow every click in the app",
  );
  assert.match(
    narrowBlock(),
    /\.rightbarbackdrop\s*\{\s*display:\s*block/,
    "…so the narrow media query is what turns it on (#50)",
  );
});
