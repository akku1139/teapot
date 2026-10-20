/**
 * Scroll follow, rewritten so "the viewport got shorter" can never be mistaken for
 * "the reader scrolled up".
 *
 * ## The bug this replaces
 *
 * Reported and never fixed: "スクロール追従中に2行以上に拡大した入力欄に入力をするとちょっと上に
 * スクロールする" — while following the tail, typing into a composer that has grown to 2+ lines
 * nudges the feed UP.
 *
 * The old rule compared samples taken at two moments and asked
 * `shouldFollowAfterChange(before, after)`. That cannot work for this case, because growing
 * the composer changes the feed's *viewport*, not its content:
 *
 *     scrollHeight = 2000, scrollTop = 1200, clientHeight = 800   -> gap 0   (at tail)
 *     composer grows 40px  ->  clientHeight = 760
 *     scrollHeight = 2000, scrollTop = 1200, clientHeight = 760   -> gap 40  (no longer "at tail")
 *
 * Nothing moved, yet the reader is now 40px from the tail. Every sample-based rule then has
 * to guess whether that 40px was the reader or the layout, and each guess produces a
 * different bug: follow sideways, or scroll to "fix" a gap that only exists because the
 * viewport shrank. The composition of several such guesses is what made the behaviour
 * drift between releases.
 *
 * ## The rule instead: follow is a STATE, and the tail is enforced continuously
 *
 * The only thing that can legitimately turn following OFF is the reader themselves moving
 * up. So that is the only input to the state, and it is decided from `scrollTop` alone,
 * which content growth and viewport changes cannot fake. Everything else is not a decision:
 * while following, the feed is simply PINNED to the tail after any layout change.
 *
 *     follow = state, flipped only by a deliberate upward scroll (or reaching the tail again)
 *     pin()  = "if following, set scrollTop so the tail is visible", called after ANY change
 *
 * Pinning is idempotent and cheap to repeat, so the answer does not depend on getting the
 * timing right. That is the property the old design lacked: it had to sample BEFORE and
 * AFTER in the same turn, and was wrong whenever layout settled outside that window.
 */

export interface TailSample {
  /** the scroll offset — decreases only when the reader moves UP */
  top: number;
  /** total content height */
  height: number;
  /** visible height */
  viewport: number;
}

/**
 * Distance from the tail, in pixels. Never negative.
 *
 * When the content is shorter than the viewport there is no tail to be away from, so 0.
 */
export function gapToTail(s: TailSample): number {
  return Math.max(0, s.height - s.top - s.viewport);
}

/**
 * The slack, in pixels, used ONLY to decide whether the reader has come back to the tail.
 *
 * A constant. It used to be derived from the composer's overflow, so "at the bottom" meant
 * a different pixel distance whenever the composer grew a line — the same coordinate jump
 * that made follow mode tug at the reader.
 */
export const TAIL_SLACK_PX = 32;

/** is the tail visible right now (within `slack`)? */
export function atTail(s: TailSample | undefined | null, slack = TAIL_SLACK_PX): boolean {
  if (!s) return true; // nothing laid out yet: nothing to be away from
  return gapToTail(s) <= slack;
}

/**
 * Did the reader themself move UP between two samples?
 *
 * This is the ONLY thing that may turn following off, so it must be impossible for layout
 * to fake it. `scrollTop` decreasing is that signal: content growing below the viewport
 * leaves `scrollTop` alone, and a viewport change (the composer growing) leaves it alone
 * too. The one thing that DOES move `scrollTop` without the reader is a shrink, where the
 * browser clamps it down to the new maximum — hence the height check.
 */
export function movedAway(
  now: TailSample,
  prev: TailSample | undefined,
  slack = TAIL_SLACK_PX,
): boolean {
  if (!prev) return false; // first sample: nothing to compare against
  if (atTail(now, slack)) return false; // at the tail is never "away"
  const shrank = now.height < prev.height;
  if (shrank) return false; // the browser clamped scrollTop; the reader did not move
  return now.top < prev.top - 1;
}

/**
 * The offset that shows the tail.
 *
 * `scrollHeight` is not a valid `scrollTop`, but the browser CLAMPS assignments to the real
 * maximum — which is exactly "show the tail". Using it (rather than
 * `height - viewport`) means we never have to be right about `viewport`, which is the value
 * that was changing underneath the old design.
 */
export function tailOffset(s: TailSample): number {
  return s.height;
}

/**
 * Should the "jump to present" pill be showing?
 *
 * Only when the reader has deliberately left the tail. A pill that appears because the
 * composer grew is noise — there is nothing new below to jump to.
 */
export function shouldShowJumpToPresent(
  s: TailSample | undefined | null,
  following: boolean,
  slack = TAIL_SLACK_PX,
): boolean {
  if (!s) return false;
  if (following) return false;
  return gapToTail(s) > slack;
}
