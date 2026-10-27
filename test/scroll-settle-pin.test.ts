import { test } from "node:test";
import assert from "node:assert/strict";
import { needsSettlePin, AT_TAIL_PX, distanceToTail, isFlush } from "../frontend/lib/scroll-policy.ts";
import { forRandom, int } from "./helpers/random.ts";

/**
 * A following viewport must be re-pinned for SUB-PIXEL shortfalls (#188 follow-up).
 *
 * Reported after v0.37.83: "タイムラインを一番下までスクロールすると1秒後くらいに1pxくらいスクロールが
 * 戻される", and "スクロールバーが消えてたのに再度スクロールしようとすると出てる".
 *
 * `scrollTop = scrollHeight` clamps to the exact fractional maximum, so the pin is right; what moves is
 * the LAYOUT afterwards — a scrollbar appearing, the composer growing a line, a font or image settling.
 * Nothing re-asserted the pin, so the viewport was left a fraction short.
 *
 * The threshold has to be half a pixel, NOT `AT_TAIL_PX` (24): that constant answers "did the reader
 * intend to be at the tail", which is a question about intent. This one is arithmetic.
 */
const vp = (gap: number) => ({ top: 1000, height: 2000 + gap, viewport: 1000 });

test("a sub-pixel shortfall is re-pinned, even though it counts as 'at the tail' (#188)", () => {
  const onePxShort = vp(1);
  assert.equal(distanceToTail(onePxShort), 1);
  assert.ok(AT_TAIL_PX > 1, "precondition: the intent tolerance would call this 'at the tail'");
  assert.equal(
    needsSettlePin(true, onePxShort),
    true,
    "1px short while following must be corrected — the intent tolerance is not the arithmetic one",
  );
});

test("half a pixel is the floor, so rounding noise does not cause a loop (#188)", () => {
  assert.equal(needsSettlePin(true, vp(0)), false, "flush needs nothing");
  assert.equal(needsSettlePin(true, vp(0.5)), false, "exactly the epsilon is rounding, not a shortfall");
  assert.equal(needsSettlePin(true, vp(0.51)), true, "just past it is real");
});

test("a reader who scrolled up is NEVER pulled back (#188)", () => {
  // this is the guard that keeps the settle pass from undoing the operator's gesture
  assert.equal(needsSettlePin(false, vp(1)), false);
  assert.equal(needsSettlePin(false, vp(500)), false);
});

test("for any viewport, a following pin target is only re-applied when short (#185)", async () => {
  await forRandom(
    "settle",
    300,
    (rng) => ({ gap: int(rng, 0, 2000) / 1000, following: rng() < 0.5 }),
    ({ gap, following }) => {
      const want = following && gap > 0.5;
      assert.equal(needsSettlePin(following, vp(gap)), want, `gap=${gap} following=${following}`);
    },
  );
});

test("a FRACTIONAL scrollTop can overshoot the integer maximum (#188)", () => {
  /**
   * MEASURED on the operator's live session: scrollHeight 71249, clientHeight 555, so the integer
   * maximum is 70694 — but Firefox reported `scrollTop: 70920.25` against a lower content height and
   * `scrollHeight - scrollTop - clientHeight` of **-0.25**. The viewport was flush and the arithmetic
   * said "past the end".
   *
   * Nothing may treat that as a distance, and nothing may re-pin on it.
   */
  const pastTheEnd = { top: 70694.25, height: 71249, viewport: 555 };
  assert.equal(distanceToTail(pastTheEnd), 0, "a negative distance is not a distance");
  assert.equal(isFlush(pastTheEnd), true, "and it means flush, not overscrolled");
  assert.equal(needsSettlePin(true, pastTheEnd), false, "never re-pin on rounding");
});
