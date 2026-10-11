/**
 * When is the reader scrolling AWAY, rather than the feed growing?
 *
 * The feed keeps a user-scroll lock: while streaming, "at the bottom" must stay
 * true so follow mode keeps pinning the tail, and a deliberate scroll up must
 * turn it off. The old test was a gap heuristic —
 *
 *     gap = scrollHeight - scrollTop - clientHeight
 *     if (!nearBottom && gap > lastGap + 8 && gap > 24) userScrolledUp = true
 *
 * — and content ARRIVING BELOW also increases the gap, because `scrollTop` does
 * not move when the browser appends below the viewport. So a new tool result or
 * a burst of streaming text of more than 8px was read as "the operator scrolled
 * up": follow mode switched itself off and the "jump to present" pill appeared
 * while nobody had touched anything. That is the reported "scroll follow
 * sometimes stops on its own", and it is intermittent because it needs the
 * growth to exceed the threshold on a frame where a scroll event fires.
 *
 * Measured in the built bundle with synthetic feed geometry: a bottom-pinned
 * reader, no input at all, +30px of content → the pill appeared. +10px and +20px
 * (under the 24px floor) did not, which is the threshold showing itself.
 *
 * The discriminator is `scrollTop`. It only DECREASES when the viewport moves
 * up the content; content appended below leaves it untouched. Growth cannot fake
 * that, which is what makes it the right signal — the same reason a pixel offset
 * is unreliable for anchoring a resize (#103) but perfectly reliable for
 * telling "who moved".
 *
 * Pure and dependency-free so it can be tested under `node --test`.
 */

export interface ScrollSample {
  /** how far below the viewport the content continues */
  gap: number;
  /** the current scroll offset — decreases only when the reader moves UP */
  top: number;
}

/**
 * Did this scroll event move the reader AWAY from the tail?
 *
 * @param now     the sample just read
 * @param prev    the previous sample, or undefined on the first event
 * @param slack   how much growth to tolerate (the app's 24px floor: reflow noise,
 *                the composer growing a line, a row's <details> opening)
 */
export function isScrollingAway(
  now: ScrollSample,
  prev: ScrollSample | undefined,
  slack = 24,
): boolean {
  // Nothing to compare against: the first event cannot be a move.
  if (!prev) return false;
  // Already at the tail — the reader is not away, and this event may be the one
  // that returns them (the `else if` in the handler clears the lock).
  if (now.gap <= slack) return false;
  // The ONLY reliable evidence of a deliberate scroll up: the offset went DOWN.
  // Content appended below increases the gap without touching `top`, and treating
  // that as a user scroll is the bug this exists to fix.
  return now.top < prev.top;
}
