/**
 * #108 — "scroll-follow detaches after automatic compaction."
 *
 * ## Cause
 *
 * The compaction banner renders INSIDE the feed, so a pass changes the feed's height twice:
 *
 *   phase start  -> banner APPEARS  -> feed taller by one row
 *   phase done   -> banner REMOVED  -> feed shorter by one row
 *
 * On `phase: done` the banner goes away AND the `[compact] …` live text is cleared, so the
 * feed is suddenly SHORTER while follow mode is still true. A design that decides follow from
 * a direction comparison sees the browser clamp `scrollTop` down and calls it "the reader
 * scrolled up", so follow is silently lost on every compaction.
 *
 * ## What this file asserts
 *
 * The banner appearing and disappearing are both LAYOUT — they change `scrollHeight` and
 * nothing else — so `classifyScroll()` must never attribute them to the reader, and follow
 * must survive. Tested through the real policy rather than a private helper, because the
 * helper is what kept getting the attribution wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { atTail, classifyScroll, distanceToTail, nextFollowing } from "../frontend/lib/scroll-policy.ts";

const VIEWPORT = 800;
const at = (top: number, height: number) => ({ top, height, viewport: VIEWPORT });

test("the compaction banner appearing does not take follow away (#108)", () => {
  // a following reader at the tail of a 1000-tall feed
  const before = at(200, 1000);
  assert.ok(atTail(before), "precondition: the reader starts at the tail");
  // the banner row appears: content 44px taller, scrollTop untouched
  const after = at(200, 1044);
  assert.equal(
    classifyScroll(after, null, before.height, VIEWPORT),
    "layout",
    "a height change is layout — the reader cannot change scrollHeight",
  );
  assert.equal(nextFollowing(true, "layout", after), true, "follow must survive the banner");
});

test("the banner DISAPPEARING — the browser clamping — does not either (#108)", () => {
  const before = at(244, 1044); // at the tail of the taller feed
  assert.ok(atTail(before), "precondition: at the tail with the banner up");
  // the banner is removed: 44px shorter, and the browser clamps scrollTop down to the floor
  const after = at(200, 1000);
  assert.equal(
    classifyScroll(after, { top: 244, height: 1044 }, before.height, VIEWPORT),
    "layout",
    "a shrink is layout; the clamp is the browser, not the reader",
  );
  assert.equal(nextFollowing(true, "layout", after), true, "follow must survive the removal");
  // and the reader is genuinely back at the tail, so nothing needs correcting anyway
  assert.equal(distanceToTail(after), 0);
});

test("a compaction that leaves the reader short of the tail still keeps follow (#108)", () => {
  // the trickiest real shape: the feed shrinks AND the floor no longer coincides with where
  // the browser clamped (fractional heights, content-visibility estimates)
  const before = at(244, 1044);
  const after = at(201, 1001); // 1px short of the floor after the clamp
  assert.equal(classifyScroll(after, { top: 244, height: 1044 }, before.height, VIEWPORT), "layout");
  assert.equal(nextFollowing(true, "layout", after), true);
  // the caller re-pins while following, which is what makes the 1px irrelevant
  assert.ok(atTail(after), "a pixel short is still the tail");
});

test("compaction does not mask a REAL scroll-up (#108)", () => {
  // the guard must not be so permissive that a person is invisible: no height change, no
  // ledger match ⇒ reader
  const before = at(200, 1000);
  const after = at(60, 1000); // scrolled up 140px, same content height
  assert.equal(classifyScroll(after, null, before.height, VIEWPORT), "reader");
  assert.equal(nextFollowing(true, "reader", after), false, "a person still unpins");
});
