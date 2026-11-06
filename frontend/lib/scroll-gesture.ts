/**
 * Which reader gestures release the follow?
 *
 * `https://github.com/fluxerapp/fluxer` answers this with LISTENERS, not arithmetic: its `useScrollAnchor` cancels an
 * anchor on `wheel`, `touchstart`, `touchmove`, `pointerdown` (container) and `keydown` (window). We inferred the same
 * thing from a `scrollTop` delta, and that inference is the reported bug — "スクロール追従が上向きスクロールだと勘違いして
 * キャンセルする可能性": streaming grows the feed, the browser re-anchors, `scrollTop` moves down a little, and a sample
 * that went down looks like a reader going up.
 *
 * The rules are small enough to state and test, which is the point: the wiring only has to call them.
 */

/** A wheel that scrolls UP takes the viewport over; a wheel DOWN is still "take me to the newest". */
export function wheelReleasesFollow(deltaY: number | undefined): boolean {
  if (typeof deltaY !== "number" || !Number.isFinite(deltaY)) return false;
  return deltaY < 0;
}

/** Keys that move the reader away from the tail. End/PageDown go TOWARDS it, so they keep following. */
export function keyReleasesFollow(key: string): boolean {
  return key === "PageUp" || key === "ArrowUp" || key === "Home";
}
