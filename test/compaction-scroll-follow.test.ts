/**
 * #108 — "scroll-follow detaches after automatic compaction."
 *
 * ## Cause
 *
 * The compaction banner renders INSIDE the feed, so a pass changes the feed's height
 * twice:
 *
 *   phase start  -> banner APPEARS  -> feed taller by one row
 *   phase done   -> banner REMOVED  -> feed shorter by one row
 *
 * On `phase: done` two things happen at once: the banner goes away AND the `[compact] …`
 * live text is cleared. So the OLD live-follow effect bailed on its own guard
 * (`if (!txt && !rsn) return;`) on the one frame that mattered, and nothing re-pinned —
 * the feed had just got SHORTER, leaving the reader above the bottom with follow mode
 * still true. Nothing looked wrong: the caret still pointed down, the pill was still
 * there, no error was logged.
 *
 * ## What this file asserts now
 *
 * The fix is no longer "one more effect keyed on `compacting()` that also checks
 * `atBottom()`". It is the follow RULE in `frontend/scroll-policy.ts`, which every growth
 * path asks — and a compaction banner appearing or disappearing is just another growth
 * (or shrink) path.
 *
 * The tests here used to read `App.tsx` as TEXT and assert the shape of the effect that
 * existed for #108 (`assert.match(app, /createEffect\(… compacting() … atBottom() …/)`).
 * That is the banned pattern: it pins the SPELLING of code that has to work at runtime,
 * so it went red when the effect was replaced by a strictly better rule while the
 * behaviour was intact. These are behaviour tests of the rule instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { atTail, shouldFollowAfterChange } from "../frontend/scroll-policy.ts";

const at = (top: number, height: number, viewport = 600) => ({ top, height, viewport });
/** the reader sitting at the tail of `height`-tall content */
const tail = (height: number, viewport = 600) => at(height - viewport, height, viewport);

test("a compaction banner APPEARING keeps the feed pinned (#108)", () => {
  // the banner is a row inside the feed, so the content gets taller with no scroll
  const before = tail(1000);
  const after = at(before.top, 1000 + 44); // one banner row
  assert.equal(shouldFollowAfterChange(before, after), true);
});

test("a compaction banner DISAPPEARING keeps the feed pinned (#108)", () => {
  // THE REPORTED CASE: `phase: done` removes the banner AND clears the live text, so the
  // old effect bailed on that frame and the feed was left above the bottom. A shrink that
  // clamps scrollTop must still count as "following".
  const before = tail(1044);
  const after = at(400, 1000); // clamped to the new maximum
  assert.equal(atTail(after), true, "the clamp leaves the reader at the new tail");
  assert.equal(shouldFollowAfterChange(before, after), true);
});

test("the re-pin respects a reader who had scrolled away (#108)", () => {
  // the other half: fixing #108 must not drag a reader who deliberately moved up
  const away = at(200, 1000); // 200px from the top, well above the tail
  assert.equal(atTail(away), false);
  assert.equal(shouldFollowAfterChange(away, at(200, 1044)), false, "banner appearing");
  assert.equal(shouldFollowAfterChange(away, at(200, 1000)), false, "banner disappearing");
});

test("a compaction pass followed by more streaming is one continuous follow (#108)", () => {
  // The real sequence, in geometry: banner appears, banner goes, then the reply streams.
  // Each step is measured from the previous state as the caller would see it.
  let s = tail(1000);
  const appear = at(s.top, 1044);
  assert.equal(shouldFollowAfterChange(s, appear), true, "banner appears");
  s = tail(1044); // the caller scrolled to the tail after following
  const gone = at(400, 1000);
  assert.equal(shouldFollowAfterChange(s, gone), true, "banner goes (a clamp)");
  s = tail(1000);
  const streamed = at(s.top, 1600);
  assert.equal(shouldFollowAfterChange(s, streamed), true, "and the reply keeps following");
});

/* ---------- the two structural facts the old tests pinned ----------
 *
 * Kept, because both are still true and both matter to #108's cause — but asserted as
 * DOM/CONTRACT facts rather than as the spelling of the effect that used to fix it.
 * Everything here is checked against the BUILT bundle in scripts/smoke-web.ts instead,
 * where the banner is actually rendered; what is worth pinning here is the rule, above.
 */
test("the rule treats a banner row exactly like any other growth (#108)", () => {
  // A banner is a row in the flow, so "one row taller" and "one wrapper shorter" are the
  // only two things it can do to the geometry — both covered by the same rule.
  const before = tail(1000);
  for (const delta of [44, -44]) {
    const after = delta > 0 ? at(before.top, 1000 + delta) : at(400, 1000 + delta);
    assert.equal(
      shouldFollowAfterChange(before, after),
      true,
      `a ${delta > 0 ? "taller" : "shorter"} feed must keep following (#108)`,
    );
  }
});
