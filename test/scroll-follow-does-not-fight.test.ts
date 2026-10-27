import { test } from "node:test";
import assert from "node:assert/strict";
import { nextFollowing, atTail, distanceToTail, shouldPin, AT_TAIL_PX } from "../frontend/lib/scroll-policy.ts";

/**
 * The tail must not fight the operator's hand (#188).
 *
 * Reported as "生成中に上側に人力でスクロールしようとすると押し戻される" plus "一番下までスクロール
 * できなくてもどかしい". MEASURED on the pure policy: with the tail 2px away, a `reader` scroll moving
 * UP still returned `following: true`, because the reader branch was just `atTail(v)` and `atTail`
 * allows 24px of slack. Any small upward nudge inside that window kept follow on, and the next pin
 * shoved the row back under the cursor.
 */
const vp = (top: number, height = 2000, viewport = 1000) => ({ top, height, viewport });

test("a reader scrolling UP stops the follow, even 2px from the tail (#188)", () => {
  const atTailish = vp(998); // 2px from the bottom, inside AT_TAIL_PX
  assert.equal(distanceToTail(atTailish), 2, "precondition: this really is near the tail");
  assert.equal(
    nextFollowing(true, "reader", atTailish, 1000),
    false,
    "moving away from the tail must release the follow, or the pin pushes it back",
  );
});

test("a reader who has NOT moved away keeps the follow (#188)", () => {
  // the guard must not disable following: a no-op scroll at the tail still follows
  assert.equal(nextFollowing(true, "reader", vp(998), 998), true);
  // and scrolling DOWN obviously keeps it
  assert.equal(nextFollowing(true, "reader", vp(999), 998), true);
});

test("a reader who scrolled far up stays released (#188)", () => {
  assert.equal(nextFollowing(true, "reader", vp(500), 900), false);
  assert.equal(atTail(vp(500)), false, "and they are far from the tail anyway");
});

test("programmatic and layout scrolls still keep the follow (#188)", () => {
  // only the READER case may release it; our own pin must not switch following off
  assert.equal(nextFollowing(true, "programmatic", vp(998), 1000), true);
  assert.equal(nextFollowing(true, "layout", vp(998), 1000), true);
  // and a programmatic jump that lands at the tail RE-ENABLES it
  assert.equal(nextFollowing(false, "programmatic", vp(1000), 0), true);
});

test("the slack is what made 1-3px look 'at the bottom' (#188)", () => {
  // documents the constant the bug leaned on: a 24px window is why 1-3px never triggered a re-pin
  assert.ok(AT_TAIL_PX >= 24, `AT_TAIL_PX is ${AT_TAIL_PX}`);
  const threePxShort = vp(997);
  assert.equal(atTail(threePxShort), true, "still 'at tail' by the tolerance...");
  assert.equal(shouldPin(true, threePxShort), true, "...so it is legitimate to pin it flush");
  assert.equal(distanceToTail(threePxShort), 3, "which is what closes the residual gap");
});
