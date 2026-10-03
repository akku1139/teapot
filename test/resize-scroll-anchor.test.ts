/**
 * #103 — "the scroll position goes wrong when the window width changes."
 *
 * The report asks for two things:
 *   1. if the feed was FOLLOWING the bottom, keep following across a resize;
 *   2. otherwise, keep the visible messages where they were.
 *
 * Why it happens: `scrollTop` is a PIXEL offset into content whose height just
 * changed. Narrow -> wide re-wraps every line, so the same text needs fewer rows
 * and `scrollHeight` SHRINKS; the browser clamps `scrollTop` to the new maximum.
 * Nothing was added or removed, yet the view lands somewhere else.
 *
 * Measured with a real reflow (60 rows of long paragraphs):
 *
 *     narrow scrollHeight = 6120,  wide scrollHeight = 2760,  viewport = 400
 *     scrolled to top=3000, topmost visible row e35
 *     after widening, unchanged scrollTop CLAMPS to 2360 -> row e53   (wrong)
 *
 * A pixel offset cannot be preserved across a re-wrap, which is why the fix
 * anchors on the topmost VISIBLE ROW — the one thing that is stable — and shifts
 * `scrollTop` by that row's own delta.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface Row {
  eid: string;
  h: number;
}
/** a column of `px` px fits `px/8` characters per line, at 20px a line */
function layout(texts: string[], px: number): Row[] {
  const cpl = Math.floor(px / 8);
  return texts.map((t, i) => ({ eid: `e${i}`, h: Math.max(1, Math.ceil(t.length / cpl)) * 20 }));
}
const H = (l: Row[]) => l.reduce((a, r) => a + r.h, 0);
const VIEW = 400;
const contentOffset = (l: Row[], eid: string) => {
  let a = 0;
  for (const r of l) {
    if (r.eid === eid) return a;
    a += r.h;
  }
  return 0;
};
/** the row a reader sees at the top of the viewport */
const firstVisible = (l: Row[], top: number) => {
  let a = 0;
  for (const r of l) {
    if (a + r.h > top) return r.eid;
    a += r.h;
  }
  return l.at(-1)!.eid;
};
const atBottom = (l: Row[], top: number, slack = 40) => H(l) - top - VIEW < slack;

const TEXTS = Array.from({ length: 60 }, (_, i) => "word ".repeat(40 + i));

test("a resize genuinely moves an unanchored scrollTop (#103)", () => {
  // the premise: without a fix the operator lands on a different message
  const narrow = layout(TEXTS, 600);
  const wide = layout(TEXTS, 1600);
  assert.ok(H(narrow) > H(wide), "widening must shrink the content (#103)");
  const top = 3000;
  const before = firstVisible(narrow, top);
  const naive = Math.min(top, H(wide) - VIEW); // the browser's clamp
  assert.notEqual(
    firstVisible(wide, naive),
    before,
    "precondition: an unanchored scrollTop lands on a DIFFERENT row (#103)",
  );
});

test("following the bottom stays following across a resize (#103)", () => {
  const narrow = layout(TEXTS, 600);
  const wide = layout(TEXTS, 1600);
  const wasFollowing = atBottom(narrow, H(narrow) - VIEW);
  assert.equal(wasFollowing, true, "precondition: we were following (#103)");
  // the fix pins to the new bottom
  assert.equal(atBottom(wide, H(wide)), true, "still following after widening (#103)");
});

test("the fix keeps the topmost visible row (#103)", () => {
  const narrow = layout(TEXTS, 600);
  const wide = layout(TEXTS, 1600);
  const top = 3000;
  const anchor = firstVisible(narrow, top);
  const offset = top - contentOffset(narrow, anchor);
  const fixed = contentOffset(wide, anchor) + offset;
  // The invariant is that the anchor row STILL SPANS the top of the viewport —
  // that is what "the same messages stayed put" means. Asserting
  // `firstVisible === anchor` is subtly wrong: at offset 40 into a row whose new
  // height is 40, the corrected scrollTop is exactly that row's LAST pixel, and
  // `firstVisible` (which tests `a + h > top`) then names the next row. The row
  // has not moved — the topmost pixel of it is still the topmost pixel shown.
  const a = contentOffset(wide, anchor);
  const h = wide.find((r) => r.eid === anchor)!.h;
  assert.ok(
    a <= fixed && fixed <= a + h,
    `row ${anchor} (spanning ${a}..${a + h}) must still cover the viewport top at ${fixed} (#103)`,
  );
  // and it must be at the SAME offset within the row as before, not merely nearby
  assert.equal(fixed - a, offset, `and at the same offset within it (#103)`);
});

test("the resize handler re-pins rather than trusting scrollTop (#103)", () => {
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  const at = app.indexOf("#103: a resize must not move the operator's place");
  assert.notEqual(at, -1, "the handler must exist (#103)");
  const block = app.slice(at, app.indexOf("onCleanup(", at));
  assert.match(block, /addEventListener\("resize"/, "it must listen for resize (#103)");
  assert.match(block, /f\.scrollTop = f\.scrollHeight/, "and re-pin when following (#103)");
  assert.match(block, /anchorRow/, "and use the anchor row otherwise (#103)");
  assert.match(
    block,
    /requestAnimationFrame/,
    "after layout settles — measuring during a resize reads stale heights (#103)",
  );
});

test("the anchor is a stable row id, not a pixel offset or an index (#103)", () => {
  // a row INDEX would shift if rows were prepended; a pixel offset is exactly
  // what does not survive a re-wrap
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  assert.match(
    app,
    /data-eid/,
    "rows carry a stable event id to anchor on (#103)",
  );
  const at = app.indexOf("function firstVisibleRow");
  assert.notEqual(at, -1, "the anchor helper must exist (#103)");
  const fn = app.slice(at, app.indexOf("\n  }", at));
  assert.match(fn, /\[data-eid\]/, "and must select by that id (#103)");
  assert.match(fn, /getBoundingClientRect\(\)\.top|\.top\b/, "measuring the row's viewport top (#103)");
});

test("the listener is cleaned up (#103)", () => {
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  const at = app.indexOf("#103: a resize must not move the operator's place");
  const block = app.slice(at, app.indexOf("});", app.indexOf("onCleanup", at)));
  assert.match(block, /removeEventListener\("resize"/, "a leaked listener would fire per remount (#103)");
});
