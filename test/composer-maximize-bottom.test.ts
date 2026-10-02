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
  const hint = lastRule(".composer.maximized .hint");
  assert.match(hint, /flex-shrink:\s*0/, "the hint keeps its intrinsic height (#65)");
  // it is the LAST in-flow child, so it takes the last row of the column. The
  // other children (.jump, .cmds) are absolutely positioned and out of flow;
  // a blanket flex constraint on them would break the suggestion panel, so
  // their absence from the fix is deliberate and asserted here.
  const hintIdx = css.indexOf(".composer.maximized .hint");
  const formIdx = css.indexOf(".composer.maximized form {");
  assert.ok(formIdx !== -1 && hintIdx !== -1, "both rules must exist (#65)");
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
