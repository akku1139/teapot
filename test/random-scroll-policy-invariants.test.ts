import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atTail,
  classifyScroll,
  distanceToTail,
  floorOf,
  nextFollowing,
  shouldPin,
} from "../frontend/lib/scroll-policy.ts";
import { forRandom, int, chance, pick } from "./helpers/random.ts";

/**
 * INVARIANTS over random viewports (#185).
 *
 * There is no "expected value" for a random scroll position, so nothing here compares against a
 * fixture. What must hold for EVERY viewport is stated instead, and the degenerate cases are listed
 * explicitly because randomness is bad at producing them.
 *
 * This is the shape of test that would have caught #188: the pushback was a violated invariant
 * ("a reader moving up must not keep following"), not a wrong constant, and the hand-written fixtures
 * never moved up by 1-3px — they jumped by screenfuls.
 */
const viewport = (rng: () => number) => {
  const viewportH = int(rng, 100, 1200);
  const height = viewportH + int(rng, 0, 5000);
  const top = int(rng, 0, Math.max(0, height - viewportH));
  return { top, height, viewport: viewportH };
};

test("distanceToTail is never negative, and is zero exactly at the floor (#185)", () => {
  for (const v of [
    { top: 0, height: 100, viewport: 100 },
    { top: 0, height: 100, viewport: 500 },
    { top: 50, height: 100, viewport: 100 },
  ]) {
    assert.ok(distanceToTail(v) >= 0, "a negative distance would make atTail nonsense");
    assert.equal(distanceToTail({ ...v, top: floorOf(v) }), 0, "the floor is exactly zero away");
  }
});

test("atTail agrees with distanceToTail at every tolerance boundary (#185)", async () => {
  await forRandom("atTail", 200, viewport, (v, _i, rng) => {
    const tol = int(rng, 0, 40);
    assert.equal(atTail(v, tol), distanceToTail(v) <= tol, `tolerance ${tol} disagreed`);
  });
});

test("a reader moving UP never keeps the follow (#188 invariant)", async () => {
  await forRandom("reader-up", 300, viewport, (v, _i, rng) => {
    const up = int(rng, 1, 200);
    const previous = v.top + up; // they moved up
    assert.equal(
      nextFollowing(true, "reader", v, previous),
      false,
      `a reader moving up ${up}px from ${previous} to ${v.top} must release the follow`,
    );
  });
});

test("a reader who did not move up keeps the follow iff still near the tail (#185)", async () => {
  await forRandom("reader-still", 300, viewport, (v) => {
    // no movement: previous top equals current
    assert.equal(nextFollowing(true, "reader", v, v.top), atTail(v));
  });
});

test("programmatic and layout scrolls never RELEASE a follow (#185)", async () => {
  await forRandom("non-reader", 200, viewport, (v, _i, rng) => {
    const cause = pick(rng, ["programmatic", "layout"] as const);
    const movedALot = { ...v, top: int(rng, 0, Math.max(0, v.height - v.viewport)) };
    // we only assert the release direction: our own pin must not switch following off
    if (atTail(movedALot)) {
      assert.equal(nextFollowing(true, cause, movedALot, v.top), true, `${cause} released the follow`);
    }
  });
});

test("shouldPin implies following, for every viewport (#185)", async () => {
  await forRandom("shouldPin", 200, viewport, (v, _i, rng) => {
    const following = chance(rng, 0.5);
    if (shouldPin(following, v)) assert.equal(following, true, "pinning without following is a bug");
  });
});

test("classifyScroll is total: every input maps to exactly one cause (#185)", async () => {
  await forRandom("classify", 300, viewport, (v, _i, rng) => {
    const cause = classifyScroll(v, chance(rng, 0.5) ? { top: v.top, height: v.height } : null, chance(rng, 0.5) ? v.height : undefined, chance(rng, 0.5) ? v.viewport : undefined);
    assert.ok(["reader", "programmatic", "layout"].includes(cause), `unknown cause ${String(cause)}`);
  });
});

test("a taller feed at the same top is never 'reader' (#185)", async () => {
  // an image finishing layout grows `height`; that is a layout change, not the operator scrolling
  await forRandom("layout-grow", 200, viewport, (v, _i, rng) => {
    const grown = { ...v, height: v.height + int(rng, 1, 500) };
    assert.equal(
      classifyScroll(grown, null, v.height, v.viewport),
      "layout",
      "a height change must not be mistaken for a gesture",
    );
  });
});
