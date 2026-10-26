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
} from "../frontend/lib/scroll-policy.ts";

const vp = (top: number, height = 2000, viewport = 800) => ({ top, height, viewport });
const TAIL = 1200;

test("the tail is a real tolerance, not a fudge for ambiguity (#scroll)", () => {
  assert.ok(atTail(vp(TAIL)), "exactly at the floor is at the tail");
  assert.ok(atTail(vp(TAIL - AT_TAIL_PX)), "a few px short is still the tail");
  assert.ok(!atTail(vp(TAIL - AT_TAIL_PX - 1)), "past the tolerance is not");
  assert.equal(distanceToTail(vp(0, 400, 800)), 0);
  assert.ok(atTail(vp(0, 400, 800)), "a feed that does not overflow is always at its tail");
  assert.equal(floorOf(vp(0, 400, 800)), 0, "the floor cannot go negative");
});

test("a viewport SHRINK — the composer growing — is not the reader leaving (#scroll)", () => {
  const before = vp(TAIL, 2000, 800);
  const after = vp(TAIL, 2000, 760); 
  assert.equal(
    classifyScroll(after, null, before.height, before.viewport),
    "layout",
    "a viewport change is layout: the floor moved and scrollTop did not",
  );
  assert.ok(
    nextFollowing(true, "programmatic", after),
    "a viewport shrink must never turn following off",
  );
});

test("our OWN write, delivered late, is not the reader (#scroll)", () => {
  const ledger = { top: TAIL, height: 2000 };
  const after = vp(TAIL);
  assert.equal(classifyScroll(after, ledger, 2000), "programmatic");
});

test("a browser CLAMP after a shrink is not the reader (#scroll)", () => {
  const ledger = { top: 1200, height: 2000 };
  const now = vp(900, 1700); 
  assert.equal(floorOf(now), 900);
  assert.equal(
    classifyScroll(now, ledger, 2000),
    "layout",
    "a height change is layout — the reader cannot change scrollHeight",
  );
  assert.equal(
    classifyScroll(now, ledger, 1700),
    "programmatic",
    "landing exactly on min(ledger, floor) is a clamp, not a person",
  );
});

test("content growing below a following reader keeps following (#scroll)", () => {
  const before = vp(TAIL);
  const after = vp(TAIL, 2400); 
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
  assert.ok(STICKY_PX > AT_TAIL_PX, "the sticky range must be wider than the acquire range");
  const justPast = vp(TAIL - AT_TAIL_PX - 5);
  assert.ok(!atTail(justPast), "precondition: it is outside the acquire range");
  assert.ok(shouldPin(true, justPast), "…but still inside the sticky range, so it stays pinned");
  assert.ok(!shouldPin(true, vp(TAIL - STICKY_PX - 50)), "far away is not pinned");
  assert.ok(!shouldPin(false, vp(TAIL)), "not following is never pinned, even at the tail");
});

test("the first delivery in a fresh feed does not count as a reader scroll (#send-scroll)", () => {
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
  const grown = vp(TAIL, 2000, 760); 

  assert.equal(classifyScroll(grown, null, 2000, 800), "layout");
  assert.equal(nextFollowing(true, "layout", grown), true);

  assert.equal(classifyScroll(grown, null, 2000, 760), "reader");
  assert.ok(shouldPin(true, grown), "a viewport shrink of 40px is inside the sticky range");
  assert.equal(
    nextFollowing(true, "reader", grown),
    false,
    "misattributed, follow is dropped — which is the bug, and why the geometry must be recorded",
  );
});

test("a reader parked mid-history is not rescued by being near the tail (#scroll)", () => {
  const parked = vp(TAIL - STICKY_PX - 200, 2000, 760);
  assert.ok(!atTail(parked), "precondition: genuinely away");
  assert.equal(nextFollowing(true, "reader", parked), false, "a real departure still unpins");
});

test("a content-visibility unskip is a LAYOUT cause, so it cannot drop follow (#firefox)", () => {
  const before = vp(600, 4000); 
  assert.ok(!atTail(before), "precondition: the reader is not at the tail");

  const after = vp(600, 4000 + 260);
  assert.equal(
    classifyScroll(after, null, before.height, before.viewport),
    "layout",
    "a height change is layout — the reader cannot change scrollHeight",
  );
  assert.equal(nextFollowing(false, "layout", after), false, "a parked reader stays parked");

  const shrank = vp(600, 4000 - 260);
  assert.equal(classifyScroll(shrank, null, before.height, before.viewport), "layout");
});

test("a LARGE resync delta is refused, because it is a stale anchor not an unskip (#scroll)", () => {
  const MAX = 240;
  assert.ok(MAX >= 120, `a single row can legitimately be ~${MAX}px, so the bound must not be tiny`);
  assert.ok(MAX < 500, "the reported jump was ~500px — the bound must refuse that class of error");

  const shouldCorrect = (delta: number) => Math.abs(delta) >= 1 && Math.abs(delta) <= MAX;
  assert.equal(shouldCorrect(6), true, "a normal unskip correction");
  assert.equal(shouldCorrect(-180), true, "a large but plausible row");
  assert.equal(shouldCorrect(0.4), false, "sub-pixel is rounding, which would add jitter");
  assert.equal(shouldCorrect(500), false, "the reported jump must be refused");
  assert.equal(shouldCorrect(-900), false, "and so must a large correction upward");
});
