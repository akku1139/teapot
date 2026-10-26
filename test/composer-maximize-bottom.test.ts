import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

function lastRule(selector: string): string {
  let i = 0;
  let found = "";
  for (;;) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const prevClose = css.lastIndexOf("}", open);
    const sel = css.slice(prevClose === -1 ? 0 : prevClose + 1, open);
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
    if (clean.split(",").some((part) => part.trim() === selector))
      found += (found ? "\n" : "") + stripComments(css.slice(open + 1, close));
    i = close + 1;
  }
  if (!found) throw new Error(`no rule with selector ${selector}`);
  return found;
}

function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "");
}

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

test("the maximized FORM absorbs the spare height (#65)", () => {
  const form = exactRule(".composer.maximized form");
  assert.match(form, /flex:\s*1/, "the form must take the leftover height (#65)");
  assert.match(
    form,
    /min-height:\s*0/,
    "the form needs min-height:0 or it cannot shrink and the hint is pushed again (#65)",
  );
});

test("the textarea fills the form instead of competing with it (#65)", () => {
  const ta = exactRule(".composer.maximized textarea");
  assert.match(ta, /flex:\s*1/, "the textarea fills the form (#65)");
  assert.match(ta, /height:\s*auto\s*!important/, "autosize still stands down when maximized (#65)");
  assert.match(ta, /max-height:\s*none/, "and the 160px cap is lifted (#65)");
});

test("the hint is pinned to the last row, not pushed by the form (#65)", () => {
  assert.match(
    lastRule(".composer .hint"),
    /flex-shrink:\s*0/,
    "the hint keeps its intrinsic height in BOTH states (#65)",
  );
  assert.match(
    lastRule(".composer"),
    /flex-direction:\s*column/,
    "the composer is a column, so DOM order IS visual order (#65)",
  );
});

test("the composer is a flex column, which is what makes this layout meaningful (#65)", () => {
  const col = lastRule(".composer");
  assert.match(col, /display:\s*flex/, "the composer must be a flex column (#65)");
  assert.match(col, /flex-direction:\s*column/, "column direction (#65)");
  const max = lastRule(".composer.maximized");
  assert.match(max, /position:\s*absolute/, "maximized overlays the timeline (#65)");
  assert.match(max, /inset:\s*0/, "covering it entirely (#65)");
});

function hintRules(src: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = stripComments(m[1]!).trim();
    if (selector.includes(".hint") || m[2]!.includes("hint"))
      out.push({ selector, body: stripComments(m[2]!) });
  }
  return out;
}

test("the maximized state overrides NOTHING that changes the hint's height (#65)", () => {
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
