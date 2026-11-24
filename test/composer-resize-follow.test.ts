/**
 * Shrinking the composer must not release the scroll follow (#294).
 *
 * "入力欄の行数を減らしてからまた増やすとタイムラインの位置が追従しない" — the feed is at the tail, the composer is made
 * taller (feed shrinks, tail is still the tail), then shorter again. Growing the FEED clamps `scrollTop` down, and the
 * browser reports that as a scroll: two samples for one composer change.
 *
 * MEASURED in the real bundle (headless Firefox, the operator's own session): one shrink emitted
 * `[top 62702, height 63152, viewport 450]` and then `[top 62606, height 63152, viewport 546]`. The second sample has an
 * UNCHANGED height, so a height-only "did the box move?" test said no, and the 96px drop in `top` was read as the reader
 * scrolling up — the follow was released and growing the composer again left the feed 76px short with "jump to present".
 *
 * The fixture below is those two samples, in order.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  atTail,
  classifyScroll,
  distanceToTail,
  layoutChanged,
  layoutExplainsScroll,
} from "../frontend/lib/scroll-policy.ts";

const TAIL_SAMPLE = { top: 62702, height: 63152, viewport: 450 };
const AFTER_SHRINK = { top: 62606, height: 63152, viewport: 546 };

test("a growing viewport is a layout change, not a reader gesture", () => {
  assert.equal(
    layoutChanged(AFTER_SHRINK, TAIL_SAMPLE.height, TAIL_SAMPLE.viewport),
    true,
    "the viewport grew by 96px — the box moved",
  );
  assert.equal(
    layoutChanged(AFTER_SHRINK, TAIL_SAMPLE.height, undefined),
    false,
    "with only the height in hand it looks unchanged, which is the bug this names",
  );
});

test("that sample is classified as layout, so it cannot latch the reader lock", () => {
  assert.equal(classifyScroll(AFTER_SHRINK, null, TAIL_SAMPLE.height, TAIL_SAMPLE.viewport), "layout");
});

test("the clamp accounts for the drop, so it is not read as a gesture", () => {
  assert.equal(
    layoutExplainsScroll(AFTER_SHRINK, TAIL_SAMPLE.top),
    true,
    "top is exactly where min(previousTop, height - viewport) puts it",
  );
});

test("a nudge during growth is NOT explained by the layout", () => {
  /**
   * The live-session case (#212): tokens land (the feed grows) while the reader moves 3px up. The clamp would put `top`
   * at `min(previousTop, newMax)` — 3px above it is the reader, and believing the layout here undoes their gesture.
   */
  const grown = { top: TAIL_SAMPLE.top - 3, height: TAIL_SAMPLE.height + 400, viewport: TAIL_SAMPLE.viewport };
  assert.equal(layoutExplainsScroll(grown, TAIL_SAMPLE.top), false);
});

test("the shrink leaves the viewport flush with the tail", () => {
  assert.equal(distanceToTail(AFTER_SHRINK), 0, "the composer shrink moves the viewport, not the reader");
  assert.equal(atTail(AFTER_SHRINK), true);
});

test("a real upward gesture is still a gesture", () => {
  const reader = { top: TAIL_SAMPLE.top - 300, height: TAIL_SAMPLE.height, viewport: TAIL_SAMPLE.viewport };
  assert.equal(layoutChanged(reader, TAIL_SAMPLE.height, TAIL_SAMPLE.viewport), false, "nothing moved but the reader");
  assert.equal(classifyScroll(reader, null, TAIL_SAMPLE.height, TAIL_SAMPLE.viewport), "reader");
  assert.equal(atTail(reader), false);
});
