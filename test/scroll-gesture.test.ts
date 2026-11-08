import test from "node:test";
import assert from "node:assert/strict";
import { keyReleasesFollow, keyTargetsTimeline, wheelReleasesFollow } from "../frontend/lib/scroll-gesture.ts";

test("a wheel up releases the follow, a wheel down does not (#212)", () => {
  /**
   * "新しいメッセージが来た時にスクロール追従されないケースがある" and "スクロール追従が上向きスクロールだと勘違いして
   * キャンセルする可能性" are the two halves of the same mistake: the follow was released by a `scrollTop` delta instead
   * of by the gesture that produced it.
   */
  assert.equal(wheelReleasesFollow(-120), true, "scrolling up is the reader taking over");
  assert.equal(wheelReleasesFollow(120), false, "scrolling down towards the newest must keep following");
  assert.equal(wheelReleasesFollow(0), false);
  assert.equal(wheelReleasesFollow(undefined), false, "an event without a delta is not evidence");
  assert.equal(wheelReleasesFollow(Number.NaN), false);
});

test("only the keys that move AWAY from the tail release it", () => {
  for (const key of ["PageUp", "ArrowUp", "Home"]) assert.equal(keyReleasesFollow(key), true, key);
  for (const key of ["PageDown", "End", "ArrowDown", "a", "Escape"]) {
    assert.equal(keyReleasesFollow(key), false, key);
  }
});

/**
 * A reading key belongs to the TIMELINE only when it comes from the timeline (or the page background).
 *
 * The listener is on `window`, so PageUp in the terminal or in a settings input released the timeline's follow — and
 * nothing said so: the feed simply stopped following, and the next send did not scroll.
 */
test("a reading key outside the feed does not release the timeline's follow", () => {
  const base = { target: {}, editable: false, isBackground: false, insideFeed: false };
  assert.equal(keyTargetsTimeline({ ...base, insideFeed: true }), true, "pressed on the feed itself");
  assert.equal(keyTargetsTimeline({ ...base, isBackground: true }), true, "pressed with nothing focused");
  assert.equal(keyTargetsTimeline({ ...base, insideFeed: false }), false, "pressed in the terminal or a panel");
  assert.equal(keyTargetsTimeline({ ...base, insideFeed: true, editable: true }), false, "a text field never scrolls the feed");
  assert.equal(keyTargetsTimeline({ ...base, isBackground: true, editable: true }), false);
});
