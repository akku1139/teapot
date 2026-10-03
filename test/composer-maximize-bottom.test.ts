/**
 * #65 — "maximizing the prompt field also moves the BOTTOM edge of the prompt
 *        field, and the hint text below it moves too. I want the bottom edge
 *        fixed."
 *
 * One cause, not two. The maximized composer is a flex column: the form is
 * `flex: 1`, and the textarea INSIDE the form is also `flex: 1`. So the two
 * compete for the leftover height, and the hint — which sits in normal flow
 * after the form — is pushed to wherever the form happens to end. The textarea
 * grows line by line as a prompt is typed, so every line shifted the hint.
 *
 * The fix gives the space to exactly ONE element: the form (the thing with a
 * visible box around it) absorbs it, the textarea fills the form, and the hint
 * keeps the last row of the column and stays put.
 *
 * happy-dom does no layout, so this pins the CSS contract that governs the
 * geometry — the same approach as the #44 and #57 CSS tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/**
 * The MERGED body of every rule whose selector list contains `selector` exactly.
 *
 * Two things make this more than a regexp:
 *
 *  - #65's rules were added after #44's and #57's for the same block, so the
 *    authoritative declaration is the LATER one — a first-match search finds
 *    the pre-#65 declaration and reports the bug as fixed when it is not.
 *  - but `.composer` is declared TWICE, and the two halves live in different
 *    rules (`position: relative` in one, `display: flex; flex-direction:
 *    column` in the other). Taking only the last body loses half of it.
 *
 * So collect every matching body, in source order, and assert against all of
 * them together. A comment is not a rule: #65's comment quotes
 * `.composer.maximized form` verbatim, and matching on raw text finds that
 * comment's "body" first.
 */
function lastRule(selector: string): string {
  let i = 0;
  let found = "";
  for (;;) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const prevClose = css.lastIndexOf("}", open);
    const sel = css.slice(prevClose === -1 ? 0 : prevClose + 1, open);
    // strip comments so explanatory prose is never mistaken for a selector
    const clean = sel.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    let depth = 0;
    let close = -1;
    for (let j = open; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close === -1) break;
    // match a whole selector in the list, so `.composer.maximized form` does
    // not also match a LATER rule that merely mentions it (`.maxbtn, ... form > button`)
    if (clean.split(",").some((part) => part.trim() === selector))
      found += (found ? "\n" : "") + stripComments(css.slice(open + 1, close));
    i = close + 1;
  }
  if (!found) throw new Error(`no rule with selector ${selector}`);
  return found;
}

/**
 * Drop CSS comments from a rule body.
 *
 * Load-bearing, not tidiness: the #65 comment explains the fix in prose and
 * QUOTES `min-height: 0` while doing so. Asserting against a body that still
 * contains its comment matches that sentence and reports the bug as fixed when
 * the declaration is gone — which is exactly what happened to this file.
 */
function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Body of the rule whose selector list is EXACTLY `selector` (last one wins). */
function exactRule(selector: string): string {
  let i = 0;
  let found = "";
  for (;;) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const prevClose = css.lastIndexOf("}", open);
    const sel = css
      .slice(prevClose === -1 ? 0 : prevClose + 1, open)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    let depth = 0;
    let close = -1;
    for (let j = open; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close === -1) break;
    if (sel === selector) found = stripComments(css.slice(open + 1, close));
    i = close + 1;
  }
  if (!found) throw new Error(`no rule whose selector is exactly ${selector}`);
  return found;
}

/* ---------- the space has exactly one owner ---------- */

test("the maximized FORM absorbs the spare height (#65)", () => {
  // ONLY the rule whose selector is exactly this. `lastRule` merges every
  // matching body, and a later rule that merely MENTIONS
  // `.composer.maximized form` in a selector list would otherwise satisfy these
  // assertions on the pre-fix CSS — which is exactly what happened when this
  // test was first written.
  const form = exactRule(".composer.maximized form");
  assert.match(form, /flex:\s*1/, "the form must take the leftover height (#65)");
  // A flex item that is allowed to shrink needs min-height:0, or it refuses to
  // go below its content and the same overflow returns by another route.
  assert.match(
    form,
    /min-height:\s*0/,
    "the form needs min-height:0 or it cannot shrink and the hint is pushed again (#65)",
  );
});

test("the textarea fills the form instead of competing with it (#65)", () => {
  // This is fine on its own — the bug was the FORM and the textarea both
  // claiming `flex: 1` while the hint sat below them in normal flow.
  const ta = exactRule(".composer.maximized textarea");
  assert.match(ta, /flex:\s*1/, "the textarea fills the form (#65)");
  assert.match(ta, /height:\s*auto\s*!important/, "autosize still stands down when maximized (#65)");
  assert.match(ta, /max-height:\s*none/, "and the 160px cap is lifted (#65)");
});

test("the hint is pinned to the last row, not pushed by the form (#65)", () => {
  // This used to require a `.composer.maximized .hint` rule. It no longer exists,
  // deliberately: every property it set that affected HEIGHT was a source of
  // drift (see the header). The pinning now comes entirely from the shared
  // `.composer .hint` rule, which applies to both states — which is strictly
  // better, because there is no longer a second place for the two to disagree.
  assert.match(
    lastRule(".composer .hint"),
    /flex-shrink:\s*0/,
    "the hint keeps its intrinsic height in BOTH states (#65)",
  );
  // the other children (.jump, .cmds) are absolutely positioned and out of flow;
  // a blanket flex constraint on them would break the suggestion panel, so their
  // absence is deliberate and asserted here.
  assert.match(
    lastRule(".composer"),
    /flex-direction:\s*column/,
    "the composer is a column, so DOM order IS visual order (#65)",
  );
});


/* ---------- the geometry that follows ---------- */

test("the composer is a flex column, which is what makes this layout meaningful (#65)", () => {
  const col = lastRule(".composer");
  assert.match(col, /display:\s*flex/, "the composer must be a flex column (#65)");
  assert.match(col, /flex-direction:\s*column/, "column direction (#65)");
  const max = lastRule(".composer.maximized");
  assert.match(max, /position:\s*absolute/, "maximized overlays the timeline (#65)");
  assert.match(max, /inset:\s*0/, "covering it entirely (#65)");
});

test("the maximize control and the class are still wired (#65)", () => {
  assert.match(
    app,
    /"composer" \+ \(composerMaximized\(\) \? " maximized" : ""\)/,
    "the maximized class must still be applied (#65)",
  );
  assert.match(app, /composerMaximized\(\)/, "and be driven by state (#65)");
});

/* ---------- the BOTTOM EDGE, not just the growth (#65, second pass) ---------- */

/*
 * The first #65 fix added `min-height: 0` so the form would stop growing and
 * push the hint down. That fixed the GROWTH but not the POSITION, and the
 * complaint came back:
 *
 *   "下端は固定されていて欲しい … の位置もそれによってずれる"
 *
 * Two independent causes, both in the maximized overrides:
 *
 *  1. `.composer.maximized` used `padding-bottom: 10px` while the normal
 *     `.composer` uses `18px`. The wrapper is `position:absolute; inset:0`, so
 *     that padding is the ONLY thing anchoring the hint — and it differed by
 *     8px between states. Maximizing therefore moved the composer's bottom
 *     edge, which is precisely what was asked not to happen.
 *
 *  2. the maximized hint carried `white-space: nowrap` + `text-overflow:
 *     ellipsis`, while the normal `.hint` wraps. On a narrow screen the normal
 *     hint occupies two lines and the maximized one a single clipped line, so
 *     the gap between the input and the text below changed with viewport width.
 */



/*
 * #65, third pass. Two earlier fixes each moved the bottom edge by a different
 * amount, and both came from ONE rule:
 *
 *   1. `.composer.maximized` used `padding-bottom: 10px` against the normal
 *      composer's `18px` — 8px of drift.
 *   2. `.composer.maximized .hint` then overrode `margin-top` AND `line-height`,
 *      while the shared `.hint` sets neither. The extra line-height made the
 *      hint's box ~2px taller, which surfaced as the reported residual
 *      "3pxくらい上にシフトする".
 *
 * Matching values one property at a time kept finding a new one. So the rule is
 * now structural: the maximized state must override NOTHING that affects the
 * hint's height, and the hint is styled solely by the shared rule. That is what
 * these assert — so a fourth override cannot be added without a test failing.
 */

/**
 * Every rule whose body mentions the hint, with COMMENTS STRIPPED from the
 * selector.
 *
 * The stripping matters: a naive `[^{}]+` selector capture swallows the comment
 * block above each rule, so a rule about `.composer.maximized .hint` arrives
 * with three paragraphs of prose glued to its name — and an `includes("hint")`
 * then matches the COMMENT, not the selector. That made these tests pass against
 * a stylesheet containing the exact rule they exist to forbid.
 */
function hintRules(src: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = stripComments(m[1]!).trim();
    // select on the SELECTOR, not the body: a rule like
    // `.composer.maximized .hint { line-height: 1.4 }` says "hint" only in its
    // selector, and filtering on the body missed exactly the rule these tests
    // exist to forbid.
    if (selector.includes(".hint") || m[2]!.includes("hint"))
      out.push({ selector, body: stripComments(m[2]!) });
  }
  return out;
}

test("the maximized state overrides NOTHING that changes the hint's height (#65)", () => {
  // only rules that target the HINT ITSELF. `.composer.maximized`'s own padding
  // is legitimate and is asserted separately.
  const offenders = hintRules(css).filter(
    (r) =>
      r.selector.includes("maximized") &&
      r.selector.includes("hint") &&
      /line-height|margin-top|font-size|padding/.test(r.body),
  );
  assert.deepEqual(
    offenders.map((o) => o.selector),
    [],
    `a maximized hint rule must not touch anything that changes its height (#65); found ${JSON.stringify(offenders)}`,
  );
});

test("there is no separate maximized-hint rule at all (#65)", () => {
  const maximizedHint = hintRules(css).filter(
    (r) => r.selector.includes("maximized") && r.selector.includes("hint"),
  );
  assert.deepEqual(maximizedHint, [], "the maximized hint must be styled only by the shared rule (#65)");
});

test("the hint is still pinned to the last row (#65)", () => {
  // the one thing needed: the growing form must not squeeze it. That comes from
  // the shared rule, so it applies to both states.
  assert.match(
    lastRule(".composer .hint"),
    /flex-shrink:\s*0/,
    "the hint must not shrink when the form grows (#65)",
  );
  assert.match(
    lastRule(".composer.maximized form"),
    /min-height:\s*0/,
    "and the form must absorb the leftover space (#65)",
  );
});

test("the maximized composer keeps the normal bottom padding (#65)", () => {
  // compare the BOTTOM value rather than asserting a literal — the invariant is
  // "they match", not "it is 18"
  const bottomOf = (body: string): string | null => {
    const m = body.match(/padding:\s*([^;]+)/);
    if (m) {
      const parts = m[1]!.trim().split(/\s+/);
      return parts.length === 3 ? parts[2]! : parts[1] ?? null;
    }
    const b = body.match(/padding-bottom:\s*([^;]+)/);
    return b ? b[1]!.trim() : null;
  };
  assert.equal(
    bottomOf(lastRule(".composer.maximized")),
    bottomOf(lastRule(".composer")),
    `the maximized composer must anchor the hint at the SAME distance from the bottom (#65)`,
  );
});

test("the shared hint rule carries no nowrap or ellipsis (#65)", () => {
  const hint = lastRule(".hint");
  assert.doesNotMatch(hint, /white-space:\s*nowrap/, "the hint must wrap (#65)");
  assert.doesNotMatch(hint, /text-overflow:\s*ellipsis/, "and must not be clipped (#65)");
});
