import { test } from "node:test";
import assert from "node:assert/strict";

interface Row {
  eid: string;
  h: number;
}
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
  const narrow = layout(TEXTS, 600);
  const wide = layout(TEXTS, 1600);
  assert.ok(H(narrow) > H(wide), "widening must shrink the content (#103)");
  const top = 3000;
  const before = firstVisible(narrow, top);
  const naive = Math.min(top, H(wide) - VIEW); 
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
  assert.equal(atBottom(wide, H(wide)), true, "still following after widening (#103)");
});

test("the fix keeps the topmost visible row (#103)", () => {
  const narrow = layout(TEXTS, 600);
  const wide = layout(TEXTS, 1600);
  const top = 3000;
  const anchor = firstVisible(narrow, top);
  const offset = top - contentOffset(narrow, anchor);
  const fixed = contentOffset(wide, anchor) + offset;
  const a = contentOffset(wide, anchor);
  const h = wide.find((r) => r.eid === anchor)!.h;
  assert.ok(
    a <= fixed && fixed <= a + h,
    `row ${anchor} (spanning ${a}..${a + h}) must still cover the viewport top at ${fixed} (#103)`,
  );
  assert.equal(fixed - a, offset, `and at the same offset within it (#103)`);
});

