/**
 * The scroll-follow rule, tested against every way the feed can grow.
 *
 * The previous design decided follow mode from a STICKY flag flipped by `onscroll`, so any
 * content that grew WITHOUT a scroll event left the answer stale. These cases are those
 * growth paths, expressed as geometry: none of them may drop the reader out of follow
 * mode, and a deliberate scroll up must.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TAIL_SLACK_PX,
  atTail,
  gapToTail,
  shouldFollowAfterChange,
  shouldShowJumpToPresent,
} from "../frontend/scroll-policy.ts";

/** geometry helpers: the viewport is 600px tall, content starts at `height` */
const at = (top: number, height: number, viewport = 600) => ({ top, height, viewport });
/** the reader sitting at the tail of `height`-tall content */
const tail = (height: number, viewport = 600) => at(height - viewport, height, viewport);

test("a reader at the tail follows when content grows below them (#scroll)", () => {
  // the live bubble streaming a delta: height grows, scrollTop unchanged
  const before = tail(1000);
  const after = at(before.top, 1400);
  assert.equal(shouldFollowAfterChange(before, after), true);
  // ACROSS SEVERAL CHUNKS the reader has been scrolled to the new tail in between, so the
  // "before" sample is the freshly-followed one — that is what the caller measures after
  // it scrolls. Using the stale `after` (400px above the new tail) would read as "away",
  // which is exactly the mistake the sticky-flag design made.
  const followed = tail(1400);
  assert.equal(shouldFollowAfterChange(followed, at(followed.top, 2000)), true);
});

test("a reader scrolled UP does not get yanked back (#scroll)", () => {
  // deliberate scroll up: scrollTop decreases while height stays put
  const before = at(400, 1000);
  const after = at(200, 1000);
  assert.equal(shouldFollowAfterChange(before, after), false);
  assert.equal(atTail(after), false);
});

test("a reader part-way up is NOT considered at the tail (#scroll)", () => {
  assert.equal(atTail(at(200, 1000)), false);
  assert.equal(shouldFollowAfterChange(at(200, 1000), at(200, 1400)), false);
});

test("growth cannot fake a scroll-away, however large (#scroll)", () => {
  // The bug this replaces: a +30px tool result grew the gap past the threshold and follow
  // switched itself off with nobody touching anything. Growth leaves `scrollTop` alone, so
  // no amount of it may read as "away".
  for (const growth of [30, 300, 3000]) {
    const before = tail(1000);
    const after = at(before.top, 1000 + growth);
    assert.equal(
      shouldFollowAfterChange(before, after),
      true,
      `growing by ${growth}px must not break follow`,
    );
  }
});

test("content SHRINKING (browser clamping scrollTop) does not count as scrolling away (#scroll)", () => {
  // When the feed shrinks the browser clamps scrollTop DOWN to the new maximum. That is
  // not the reader moving: it must not lock follow off. The clamp lands exactly at the new
  // tail, so the numbers have to be consistent: height 1000 with a 600px viewport can only
  // scroll to 400.
  const before = tail(2000); // top 1400, at the tail of 2000
  const after = at(400, 1000); // clamped from 1400 to the new maximum
  assert.equal(gapToTail(after), 0, "a clamp leaves the reader exactly at the tail");
  assert.equal(atTail(after), true, "after a clamp the reader IS at the tail");
  assert.equal(shouldFollowAfterChange(before, after), true);
});

test("every growth path in the app is covered by the same rule (#scroll)", () => {
  // Each of these adds height with scrollTop unchanged. Enumerated because each one was a
  // separate bug report at some point.
  const before = tail(1000);
  const paths: Record<string, number> = {
    "live delta": 1200,
    "thinking block growing": 1600,
    "tool row expanding on its result": 2400,
    "<details> opened by a click": 2800,
    "image finished loading": 3600,
    "compaction divider appeared": 3800,
  };
  for (const [what, height] of Object.entries(paths)) {
    assert.equal(
      shouldFollowAfterChange(before, at(before.top, height)),
      true,
      `${what} must keep the feed following`,
    );
  }
});

test("the slack is a CONSTANT, not a function of the composer (#scroll)", () => {
  // It used to be `24 + min(composer overflow, 160)`, so "at the bottom" meant a different
  // pixel distance whenever the composer grew a line — the same jump that made follow mode
  // tug at the reader.
  assert.equal(TAIL_SLACK_PX, 32);
  // a 30px gap counts as the tail; the dynamic version rejected it when the composer grew
  assert.equal(atTail(at(1000 - 600 - 30, 1000)), true);
  // and a gap wider than the slack does not
  assert.equal(atTail(at(1000 - 600 - 100, 1000)), false);
});

test("the jump-to-present pill appears exactly when there is unseen content below (#scroll)", () => {
  assert.equal(shouldShowJumpToPresent(tail(1000)), false, "at the tail: no pill");
  assert.equal(shouldShowJumpToPresent(at(100, 1000)), true, "scrolled up: pill");
  // a small gap is within the slack — no pill, or it flickers while the reader is at the
  // bottom of a growing stream
  assert.equal(shouldShowJumpToPresent(at(1000 - 600 - 20, 1000)), false);
  assert.equal(shouldShowJumpToPresent(undefined), false);
});

test("no element yet means 'follow' — the first content lands at the tail (#scroll)", () => {
  assert.equal(atTail(undefined), true);
  assert.equal(shouldFollowAfterChange(undefined, at(0, 800)), true);
  assert.equal(gapToTail(at(0, 800)), 200);
});
