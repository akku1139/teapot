/**
 * The scroll-follow rule, tested against every way the feed can change shape.
 *
 * Follow is a STATE, and the only thing that may turn it off is the reader moving up.
 * These cases are the ways geometry can change without the reader touching anything —
 * none of them may flip the state, and a deliberate scroll up must.
 *
 * The case at the top is the reported bug this design exists to fix, and it is the one
 * the previous sample-comparison rule could not express: the composer growing shrinks the
 * feed's VIEWPORT, which increases `gapToTail` without moving `scrollTop`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TAIL_SLACK_PX,
  atTail,
  gapToTail,
  movedAway,
  shouldShowJumpToPresent,
  tailOffset,
} from "../frontend/scroll-policy.ts";

/** geometry helpers: the viewport is 600px tall, content starts at `height` */
const at = (top: number, height: number, viewport = 600) => ({ top, height, viewport });
/** the reader sitting at the tail of `height`-tall content */
const tail = (height: number, viewport = 600) => at(height - viewport, height, viewport);

/* ---------- the reported bug ---------- */

test("the composer growing must NOT count as scrolling away (#scroll, #179)", () => {
  // MEASURED shape of the report "2行以上に拡大した入力欄に入力をするとちょっと上にスクロールする":
  // the composer grows 40px, so the feed's viewport SHRINKS by 40px. Content is untouched
  // and `scrollTop` does not move — but the gap to the tail becomes 40px.
  const before = tail(2000, 800); // scrollTop 1200, at the tail
  const after = at(before.top, 2000, 760); // same top, same height, viewport -40
  assert.equal(gapToTail(after), 40, "the viewport shrink really does open a 40px gap");
  assert.equal(
    movedAway(after, before),
    false,
    "the reader did not move — this must not stop following, or the pin below never runs",
  );
});

test("a viewport shrink of ANY size is not 'away', even past the slack (#scroll)", () => {
  // a taller composer, a window resize, the right panel opening: all shrink the viewport.
  // None is a scroll. The old gap-based test called this "away" once it exceeded the slack.
  const before = tail(3000, 900);
  const after = at(before.top, 3000, 300); // viewport shrank by 600px
  assert.equal(gapToTail(after), 600);
  assert.equal(movedAway(after, before), false);
  // …and the pin is what fixes it: assigning scrollHeight clamps to the real maximum
  assert.equal(tailOffset(after), 3000);
});

/* ---------- the ordinary growth paths ---------- */

test("content growing below the viewport keeps following (#scroll)", () => {
  // live bubble streaming a delta, a tool result arriving, a compaction divider appearing
  for (const grown of [1400, 2000, 5000]) {
    const before = tail(1000);
    const after = at(before.top, grown);
    assert.equal(movedAway(after, before), false, `growth to ${grown}px is not a scroll`);
  }
});

test("a SHRINK is not 'away' — the browser clamps scrollTop, the reader did not move (#scroll)", () => {
  // compaction, a tool row collapsing, switching to a shorter log. `scrollTop` drops
  // because the maximum dropped, which looks exactly like a scroll up if only `top` is
  // compared. Counting it locked follow off after every compaction.
  const before = at(1500, 2000); // gap ~0
  const after = at(700, 1200); // clamped down to the new maximum
  assert.equal(movedAway(after, before), false);
});

/* ---------- the one thing that DOES turn following off ---------- */

test("a deliberate scroll up stops following (#scroll)", () => {
  const before = tail(2000);
  const after = at(before.top - 300, 2000); // scrolled up 300px, content unchanged
  assert.equal(movedAway(after, before), true);
});

test("scrolling back to the tail resumes following — the state is symmetric (#scroll)", () => {
  const up = at(500, 2000); // far from the tail
  assert.equal(atTail(up), false);
  const back = tail(2000);
  assert.equal(atTail(back), true, "returning to the tail is what re-arms follow");
});

test("a 1px wobble is not a scroll (#scroll)", () => {
  // sub-pixel reflow, rounded scrollTop values, trackpad noise
  const before = at(1000, 2000);
  assert.equal(movedAway(at(999, 2000), before), false);
});

test("the first sample never reports movement (#scroll)", () => {
  assert.equal(movedAway(at(0, 1000), undefined), false);
});

/* ---------- the pill ---------- */

test("the jump-to-present pill only appears when the reader left the tail (#scroll)", () => {
  // following + a gap (the composer grew) must NOT offer a jump: there is nothing new below
  assert.equal(shouldShowJumpToPresent(at(1200, 2000, 760), true), false);
  // not following + a real gap: the reader went up, so offer it
  assert.equal(shouldShowJumpToPresent(at(400, 2000), false), true);
});

test("an empty or unmeasured feed offers no pill (#scroll)", () => {
  assert.equal(shouldShowJumpToPresent(null, false), false);
  assert.equal(shouldShowJumpToPresent(undefined, false), false);
});

/* ---------- the geometry helpers ---------- */

test("gapToTail never goes negative, and content shorter than the viewport is at the tail (#scroll)", () => {
  assert.equal(gapToTail(at(0, 100, 600)), 0, "a short feed has no tail to be away from");
  assert.equal(gapToTail(at(5000, 100, 600)), 0, "over-scrolled (rubber band) is still 0");
  assert.equal(atTail(at(0, 100, 600)), true);
});

test("the slack is a constant, not derived from the composer (#scroll)", () => {
  // it used to be `24 + min(composer overflow, 160)`, so "at the bottom" meant a different
  // distance whenever the composer grew a line — the same coordinate jump that made follow
  // tug at the reader
  assert.equal(TAIL_SLACK_PX, 32);
  assert.equal(atTail(at(0, 1000, 600), TAIL_SLACK_PX), false);
  assert.equal(atTail(at(368, 1000, 600), TAIL_SLACK_PX), true, "400-32 = 368 is within slack");
});

/* ---------- migrated from the retired scroll-follow.ts ---------- */

test("content growing below a tail-pinned reader is not a scroll away (#scroll)", () => {
  // The measured report behind the old module: the browser appends BELOW, so `top` is
  // unchanged and only the gap grows. 900px of new content is not the operator scrolling.
  const bottom = at(1000, 1600, 600); // gap 0
  for (const grown of [1600 + 900, 1600 + 30, 1600 + 30_000]) {
    assert.equal(
      movedAway(at(1000, grown, 600), bottom),
      false,
      `growing to ${grown}px is not a scroll — even far past the 32px slack`,
    );
  }
});

test("a small drag up still stops following (#scroll)", () => {
  const bottom = at(1000, 1600, 600);
  assert.equal(movedAway(at(700, 1600, 600), bottom), true, "300px up");
  assert.equal(movedAway(at(940, 1600, 600), bottom), true, "a 60px drag is still a deliberate move");
});
