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
 * The fix is not "one more effect keyed on `compacting()` that also checks `atBottom()`",
 * and it is no longer a before/after sample comparison either (that design could not tell
 * a viewport change from a scroll — see `scroll-policy.ts`). Follow is a STATE, and a
 * compaction banner is just another growth (or shrink) path that cannot touch it.
 *
 * These are behaviour tests of the rule. They used to read `App.tsx` as TEXT and assert
 * the shape of the old effect — the banned pattern, since it pins the SPELLING of code
 * that has to work at runtime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { atTail, movedAway } from "../frontend/scroll-policy.ts";

const at = (top: number, height: number, viewport = 600) => ({ top, height, viewport });
/** the reader sitting at the tail of `height`-tall content */
const tail = (height: number, viewport = 600) => at(height - viewport, height, viewport);

test("a compaction banner APPEARING keeps the feed pinned (#108)", () => {
  // the banner is a row inside the feed, so the content gets taller with no scroll
  const before = tail(1000);
  const after = at(before.top, 1000 + 44); // one banner row
  assert.equal(movedAway(after, before), false, "growth is not a scroll, so follow survives");
  // and the pin then shows the new tail
  assert.equal(atTail(after), false, "the reader IS momentarily 44px above the tail…");
  // …which is exactly why following must not be re-derived from that gap
});

test("a compaction banner DISAPPEARING keeps the feed pinned (#108)", () => {
  // THE REPORTED CASE: `phase: done` removes the banner AND clears the live text. The feed
  // shrinks, so the browser CLAMPS scrollTop down to the new maximum. That clamp looks
  // exactly like a scroll up if only `top` is compared — which is what detached follow.
  const before = tail(1044);
  const after = at(400, 1000); // clamped to the new maximum
  assert.equal(atTail(after), true, "the clamp leaves the reader at the new tail");
  assert.equal(
    movedAway(after, before),
    false,
    "a shrink is a clamp, not a scroll — follow must survive the banner going away",
  );
});

test("the re-pin respects a reader who had scrolled away (#108)", () => {
  // the other half: fixing #108 must not drag a reader who deliberately moved up
  const away = at(200, 1000); // 200px from the top, well above the tail
  assert.equal(atTail(away), false, "so the pill shows and the pin does not run");
  assert.equal(movedAway(at(200, 1044), away), false, "banner appearing is still not a scroll");
  assert.equal(movedAway(at(200, 1000), away), false, "banner disappearing is not one either");
});

test("a compaction pass followed by more streaming is one continuous follow (#108)", () => {
  // The real sequence, in geometry: banner appears, banner goes, then the reply streams.
  // None of the three may clear the follow state.
  const s = tail(1000);
  assert.equal(movedAway(at(s.top, 1044), s), false, "banner appears");
  const afterClamp = at(400, 1000);
  assert.equal(movedAway(afterClamp, tail(1044)), false, "banner goes (a clamp)");
  assert.equal(movedAway(at(400, 1600), afterClamp), false, "and the reply keeps following");
});

test("the rule treats a banner row exactly like any other growth (#108)", () => {
  // A banner is a row in the flow, so "one row taller" and "one wrapper shorter" are the
  // only two things it can do to the geometry — both are non-scrolls.
  const before = tail(1000);
  assert.equal(movedAway(at(before.top, 1044), before), false, "taller");
  assert.equal(movedAway(at(400, 956), before), false, "shorter (clamped)");
});
