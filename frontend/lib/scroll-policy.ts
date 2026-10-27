
export type TailSample = Viewport;

export interface Viewport {
  top: number;
  height: number;
  viewport: number;
}

export const AT_TAIL_PX = 24;

export const STICKY_PX = 64;

export function floorOf(v: Viewport): number {
  return Math.max(0, v.height - v.viewport);
}

/**
 * How far the viewport is from the tail, in CSS pixels.
 *
 * CAN BE NEGATIVE in one direction only, which is why it is clamped rather than trusted: MEASURED on the
 * operator's live session, `scrollHeight - scrollTop - clientHeight` came out as **-0.25** because
 * `scrollTop` is fractional while `scrollHeight` and `clientHeight` are integers rounded to the nearest
 * pixel. A caller that compared this to 0 with `>` would then think the viewport was flush when it was
 * a quarter-pixel past, and one that used the raw value as a distance would pin in the wrong direction.
 */
export function distanceToTail(v: Viewport | null | undefined): number {
  if (!v) return Number.POSITIVE_INFINITY;
  return Math.max(0, v.height - v.top - v.viewport);
}

/** is the viewport already flush, allowing for the sub-pixel rounding `scrollTop` can overshoot by? */
export function isFlush(v: Viewport | null | undefined, epsilon = 0.5): boolean {
  if (!v) return false;
  return Math.abs(v.height - v.top - v.viewport) <= epsilon;
}

export function atTail(v: Viewport | null | undefined, tolerance = AT_TAIL_PX): boolean {
  if (!v) return false;
  return distanceToTail(v) <= tolerance;
}

export type ScrollCause = "reader" | "programmatic" | "layout";

export function classifyScroll(
  now: Viewport,
  ledger: { top: number; height: number } | null,
  lastHeight: number | undefined,
  lastViewport?: number,
): ScrollCause {
  if (lastViewport !== undefined && Math.abs(now.viewport - lastViewport) > 0.5) return "layout";
  if (lastHeight !== undefined && Math.abs(now.height - lastHeight) > 0.5) return "layout";
  if (ledger) {
    const expected = Math.min(ledger.top, floorOf(now));
    if (Math.abs(now.top - expected) <= 0.5) return "programmatic";
  }
  return "reader";
}

export function shouldPin(following: boolean, v: Viewport): boolean {
  if (!following) return false;
  return distanceToTail(v) <= STICKY_PX;
}

/**
 * Should we keep following the tail after this scroll event?
 *
 * A `reader` gesture is the operator's own hand, and it wins: if they scrolled UP even by 2px, follow
 * must stop, or the next `pinToTail()` shoves them back. MEASURED, this was the report —
 * "生成中に上側に人力でスクロールしようとすると押し戻される" (#188): the old rule returned
 * `atTail(v)`, and `atTail` allows 24px of slack, so every small upward scroll inside that window kept
 * `following` true and the tail re-pinned underneath them.
 *
 * So the reader case needs BOTH: still at the very bottom, AND not moving away from it. `previousTop`
 * is what makes "moving away" observable — a `Viewport` alone cannot say which way they went.
 */
export function nextFollowing(
  following: boolean,
  cause: ScrollCause,
  v: Viewport,
  previousTop?: number,
): boolean {
  if (cause !== "reader") {
    return following || atTail(v);
  }
  const movedUp = previousTop !== undefined && v.top < previousTop - 0.5;
  if (movedUp) return false;
  return atTail(v);
}

/**
 * Should the settle pass re-assert the pin?
 *
 * `scrollTop = scrollHeight` lands on the exact fractional maximum, but the layout can move afterwards
 * — a scrollbar appearing, the composer growing, a font or image finishing — leaving the viewport a
 * fraction short. Reported as "1秒後に1pxくらいスクロールが戻される" (#188 follow-up).
 *
 * The threshold is HALF A PIXEL, not the 24px used for "is the reader at the tail": that tolerance is
 * about intent, this one is about arithmetic. And it is gated on `following`, so a reader who scrolled
 * up is never pulled back.
 */
export function needsSettlePin(following: boolean, v: Viewport, epsilon = 0.5): boolean {
  if (!following) return false;
  return distanceToTail(v) > epsilon;
}

export function shouldShowJumpToPresent(following: boolean, v: Viewport): boolean {
  return !following && !atTail(v);
}

export const gapToTail = distanceToTail;
