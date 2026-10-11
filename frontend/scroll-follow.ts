/**
 * When is the reader scrolling AWAY, rather than the feed growing?
 *
 * The feed locks follow mode off when the reader scrolls up. Deciding that from
 * the GAP was wrong: content appended below the viewport increases the gap
 * without moving `scrollTop`, so a tool result larger than the threshold read as
 * a deliberate scroll — follow switched itself off and the pill appeared while
 * nobody had touched anything (measured: +30px of growth was enough).
 *
 * `scrollTop` is the discriminator: it only DECREASES when the viewport moves up
 * the content. Growth cannot fake that.
 */

export interface ScrollSample {
  /** how far below the viewport the content continues */
  gap: number;
  /** the scroll offset — decreases only when the reader moves UP */
  top: number;
}

/**
 * Did this scroll event move the reader away from the tail?
 *
 * @param slack how much gap to tolerate before believing the reader moved (reflow
 *              noise, the composer growing a line, a `<details>` opening)
 */
export function isScrollingAway(
  now: ScrollSample,
  prev: ScrollSample | undefined,
  slack = 24,
): boolean {
  if (!prev) return false; // first event: nothing to compare
  if (now.gap <= slack) return false; // at the tail, so not away
  return now.top < prev.top; // the offset went UP the content
}
