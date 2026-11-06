import test from "node:test";
import assert from "node:assert/strict";
import { keyReleasesFollow, wheelReleasesFollow } from "../frontend/lib/scroll-gesture.ts";

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
