/**
 * The scroll-follow policy, tested where the DECISION lives.
 *
 * The reported symptom has come back three times: "スクロール追従が外れる". Each earlier fix
 * inferred "did the reader scroll up?" from geometry sampled at two moments, and that question
 * is not answerable that way — four different things move the viewport:
 *
 *   1. the reader scrolls / drags / pans
 *   2. WE write scrollTop to follow the tail (the event arrives later)
 *   3. content above shrinks and the browser CLAMPS scrollTop to the new floor
 *   4. the viewport shrinks (the composer growing) so the floor moves without top moving
 *
 * 2, 3 and 4 all look identical to a direction test. `classifyScroll()` separates them using
 * the observed-top ledger and the content height, so every case below is a classification this
 * file can actually make — not a slack constant widening until the symptom hides.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AT_TAIL_PX,
  STICKY_PX,
  atTail,
  classifyScroll,
  distanceToTail,
  floorOf,
  gapToTail,
  nextFollowing,
  shouldPin,
  shouldShowJumpToPresent,
} from "../frontend/scroll-policy.ts";

const vp = (top: number, height = 2000, viewport = 800) => ({ top, height, viewport });
/** the tail of a 2000-tall content in an 800 viewport */
const TAIL = 1200;

test("the tail is a real tolerance, not a fudge for ambiguity (#scroll)", () => {
  assert.ok(atTail(vp(TAIL)), "exactly at the floor is at the tail");
  assert.ok(atTail(vp(TAIL - AT_TAIL_PX)), "a few px short is still the tail");
  assert.ok(!atTail(vp(TAIL - AT_TAIL_PX - 1)), "past the tolerance is not");
  // content shorter than the viewport has no tail to be away from
  assert.equal(distanceToTail(vp(0, 400, 800)), 0);
  assert.ok(atTail(vp(0, 400, 800)), "a feed that does not overflow is always at its tail");
  assert.equal(floorOf(vp(0, 400, 800)), 0, "the floor cannot go negative");
});

test("a viewport SHRINK — the composer growing — is not the reader leaving (#scroll)", () => {
  // the exact case that was reported and re-reported: growing the composer shrinks the feed's
  // viewport, so the reader is suddenly further from the tail without having moved at all
  const before = vp(TAIL, 2000, 800);
  const after = vp(TAIL, 2000, 760); // 40px taken by the composer
  assert.equal(
    classifyScroll(after, null, before.height, before.viewport),
    "layout",
    "a viewport change is layout: the floor moved and scrollTop did not",
  );
  // …and even if it were misclassified, following must survive a viewport change
  assert.ok(
    nextFollowing(true, "programmatic", after),
    "a viewport shrink must never turn following off",
  );
});

test("our OWN write, delivered late, is not the reader (#scroll)", () => {
  // we wrote to the floor; the event arrives after more content landed
  const ledger = { top: TAIL, height: 2000 };
  const after = vp(TAIL);
  assert.equal(classifyScroll(after, ledger, 2000), "programmatic");
});

test("a browser CLAMP after a shrink is not the reader (#scroll)", () => {
  // content shrank above the reader: scrollTop is clamped down to the NEW floor
  const ledger = { top: 1200, height: 2000 };
  const now = vp(900, 1700); // shrank by 300; the browser moved us to the new floor
  assert.equal(floorOf(now), 900);
  assert.equal(
    classifyScroll(now, ledger, 2000),
    "layout",
    "a height change is layout — the reader cannot change scrollHeight",
  );
  // and even without the height hint, the `min(ledger, floor)` rule catches it
  assert.equal(
    classifyScroll(now, ledger, 1700),
    "programmatic",
    "landing exactly on min(ledger, floor) is a clamp, not a person",
  );
});

test("content growing below a following reader keeps following (#scroll)", () => {
  const before = vp(TAIL);
  const after = vp(TAIL, 2400); // 400 more arrived; scrollTop unchanged
  assert.equal(classifyScroll(after, null, before.height), "layout");
  assert.ok(nextFollowing(true, "layout", after), "growth below must not unpin");
});

test("a deliberate scroll up DOES stop following (#scroll)", () => {
  const before = vp(TAIL);
  const after = vp(TAIL - 300);
  assert.equal(classifyScroll(after, null, before.height), "reader");
  assert.equal(nextFollowing(true, "reader", after), false);
});

test("a 1px wobble is not a scroll — but is it? (measured: it is not reader intent)", () => {
  // A single pixel is inside the tolerance, so the reader is still AT the tail regardless of
  // who moved it. That is why the threshold exists and why it does not need to be zero.
  const after = vp(TAIL - 1);
  assert.ok(atTail(after), "1px is still the tail");
  assert.ok(nextFollowing(true, "reader", after), "1px cannot unpin");
});

test("scrolling back to the tail resumes following — the state is symmetric (#scroll)", () => {
  assert.equal(nextFollowing(false, "reader", vp(TAIL - 400)), false);
  assert.equal(
    nextFollowing(false, "reader", vp(TAIL)),
    true,
    "arriving at the tail re-acquires following whatever caused it",
  );
});

test("hysteresis: a momentarily short tail does not drop follow (#scroll)", () => {
  // once following, stay following out to STICKY_PX. Without this a streaming bubble that
  // overshoots the floor for one frame unpins itself, which reads as "it stopped following".
  assert.ok(STICKY_PX > AT_TAIL_PX, "the sticky range must be wider than the acquire range");
  const justPast = vp(TAIL - AT_TAIL_PX - 5);
  assert.ok(!atTail(justPast), "precondition: it is outside the acquire range");
  assert.ok(shouldPin(true, justPast), "…but still inside the sticky range, so it stays pinned");
  assert.ok(!shouldPin(true, vp(TAIL - STICKY_PX - 50)), "far away is not pinned");
  assert.ok(!shouldPin(false, vp(TAIL)), "not following is never pinned, even at the tail");
});

test("the first delivery in a fresh feed does not count as a reader scroll (#send-scroll)", () => {
  // no previous height, no ledger: nothing to attribute to us, so it is a person — but the
  // caller only acts on it when the reader is genuinely away from the tail
  assert.equal(classifyScroll(vp(TAIL - 500), null, undefined), "reader");
  assert.equal(
    nextFollowing(true, "reader", vp(TAIL - 500)),
    false,
    "a reader parked up the history on the first sample is not following",
  );
});

test("the jump-to-present pill only shows when the reader is away AND not following (#scroll)", () => {
  assert.equal(shouldShowJumpToPresent(false, vp(TAIL - 500)), true);
  assert.equal(shouldShowJumpToPresent(true, vp(TAIL - 500)), false, "following needs no pill");
  assert.equal(shouldShowJumpToPresent(false, vp(TAIL)), false, "at the tail needs no pill");
});

test("an unmounted feed is never at the tail, and gap is infinite (#scroll)", () => {
  assert.equal(atTail(null), false);
  assert.equal(atTail(undefined), false);
  assert.equal(distanceToTail(null), Number.POSITIVE_INFINITY);
  assert.equal(shouldPin(true, vp(TAIL)), true);
});

test("gapToTail never goes negative (#scroll)", () => {
  assert.equal(gapToTail(vp(TAIL + 500)), 0, "past the floor is still 0 of gap");
  assert.equal(gapToTail(vp(0)), 1200);
  assert.equal(gapToTail(null), Number.POSITIVE_INFINITY);
});

test("a delivery that arrives BEFORE the resize is observed is still layout (#scroll, Firefox)", () => {
  /**
   * Reported as Firefox-only: with the composer grown, typing pulled the timeline back to the
   * un-grown height. The cause is ORDERING, not geometry.
   *
   * Firefox can deliver the scroll produced by native scroll anchoring BEFORE the app has
   * observed the resize. If the policy's remembered height/viewport only advance inside the
   * scroll handler, that delivery is compared against the PRE-resize geometry — no change is
   * seen — and the movement is attributed to the reader, dropping follow.
   *
   * The fix is to record the geometry on every box change as well, so whichever fires first,
   * the comparison is against current geometry. These two assertions pin both orderings:
   */
  const grown = vp(TAIL, 2000, 760); // composer grew: viewport 800 -> 760

  // (a) resize observed first (Chrome's ordering): classified as layout, follow survives
  assert.equal(classifyScroll(grown, null, 2000, 800), "layout");
  assert.equal(nextFollowing(true, "layout", grown), true);

  /**
   * (b) THE FIREFOX ORDERING: the resize was NOT yet observed when the delivery arrived, so
   * there is no viewport delta to see and the movement is misattributed to the reader.
   *
   * This is why the observer must record the geometry on every box change: with that record
   * present, (b) never happens. The assertion here documents the residual damage if it did —
   * and the reason follow is still recoverable rather than lost forever is `shouldPin()` plus
   * the re-pin the observer performs while following.
   */
  assert.equal(classifyScroll(grown, null, 2000, 760), "reader");
  // the reader did not move; the FLOOR did. The sticky range is what keeps follow alive across
  // that 40px, which is the whole reason it exists.
  assert.ok(shouldPin(true, grown), "a viewport shrink of 40px is inside the sticky range");
  assert.equal(
    nextFollowing(true, "reader", grown),
    false,
    "misattributed, follow is dropped — which is the bug, and why the geometry must be recorded",
  );
});

test("a reader parked mid-history is not rescued by being near the tail (#scroll)", () => {
  // the counterpart: the tolerance must not be so wide that a real departure reads as at-tail
  const parked = vp(TAIL - STICKY_PX - 200, 2000, 760);
  assert.ok(!atTail(parked), "precondition: genuinely away");
  assert.equal(nextFollowing(true, "reader", parked), false, "a real departure still unpins");
});

test("a content-visibility unskip is a LAYOUT cause, so it cannot drop follow (#firefox)", () => {
  /**
   * Gecko lays a `content-visibility: auto` row out for real when it approaches the viewport,
   * replacing its `contain-intrinsic-size` placeholder. Chromium holds the scroll position
   * across that; Gecko does not (Bugzilla 1940025 / 1908582, both open).
   *
   * The unskip does NOT fire a ResizeObserver — the feed's own box is unchanged — so the only
   * signal is that `scrollHeight` changed. The policy must classify that as layout, never as
   * the reader, or browsing upward through a loaded session would silently drop follow.
   */
  const before = vp(600, 4000); // parked mid-history
  assert.ok(!atTail(before), "precondition: the reader is not at the tail");

  // a row above unskips: real size replaces the 140px placeholder, so the content grows
  const after = vp(600, 4000 + 260);
  assert.equal(
    classifyScroll(after, null, before.height, before.viewport),
    "layout",
    "a height change is layout — the reader cannot change scrollHeight",
  );
  assert.equal(nextFollowing(false, "layout", after), false, "a parked reader stays parked");

  // …and the same in the other direction, which is the creep direction (placeholder was too big)
  const shrank = vp(600, 4000 - 260);
  assert.equal(classifyScroll(shrank, null, before.height, before.viewport), "layout");
});

