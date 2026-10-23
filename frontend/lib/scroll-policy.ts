/**
 * Does the viewport follow the tail, and who moved it?
 *
 * ## Why this was rewritten (third time)
 *
 * Every previous version tried to infer "did the reader scroll up?" from geometry sampled at
 * two moments. That question is not answerable from geometry alone, because FOUR different
 * things change `scrollTop` or the floor under the reader:
 *
 *   1. the reader scrolls / drags the scrollbar / pans on touch
 *   2. WE write `scrollTop` to follow the tail (the delivery arrives asynchronously)
 *   3. content ABOVE shrinks and the browser CLAMPS `scrollTop` to the new floor
 *   4. the viewport shrinks (the composer growing) so the floor moves without `scrollTop` moving
 *
 * Cases 2 and 3 both look exactly like "the reader moved up" to a direction test, and case 4
 * looks like "the reader is suddenly 40px from the tail". That is why the symptom kept coming
 * back: each fix traded one misreading for another, and the constants (`TAIL_SLACK_PX = 32`)
 * were doing the work of hiding the ambiguity rather than resolving it.
 *
 * ## The rule now, taken from harnesses that get it right
 *
 * MEASURED in five production implementations (see the survey in `docs/`), two mechanisms
 * resolve cases 2-4 without guessing, and this file implements both:
 *
 * **A. The observed-top ledger** (`deepseek-harness`, `use-scroll-follow.ts`). Every
 * programmatic write records the resulting `scrollTop`. A scroll delivery is then classified by
 * asking whether the position matches `min(ledger, floor)`:
 *
 *     movedByReader = |top - min(ledger, floor)| > 0.5
 *
 * The `min(ledger, floor)` is the whole trick. When content shrinks, the browser clamps
 * `scrollTop` to the NEW floor, so the delivery lands exactly on `min(ledger, floor)` and is
 * therefore NOT reader movement. When our own write is delivered late, it lands exactly on the
 * ledger and is NOT reader movement. Only a position off both is a person.
 *
 * **B. Height-change attribution** (`fluxer`, `ScrollManager.ts`). If the content height changed
 * since the last delivery, the delivery is LAYOUT, not the reader — the reader cannot change
 * `scrollHeight`. Fluxer forces "still pinned" in that case. This catches the remaining case
 * where a clamp and a re-growth race inside one frame.
 *
 * Neither mechanism uses a slack constant to decide intent. The threshold below only answers
 * "is the tail visible", which is a legitimate question with a legitimate tolerance.
 */

/** the shape the feed measures on every scroll (kept name: many call sites use it) */
export type TailSample = Viewport;

export interface Viewport {
  /** the scroll offset */
  top: number;
  /** total content height (`scrollHeight`) */
  height: number;
  /** visible height (`clientHeight`) */
  viewport: number;
}

/**
 * How close counts as "at the tail".
 *
 * A real tolerance, not a fudge for ambiguity: content can stop a few pixels short of the floor
 * (`content-visibility` estimates, a fractional line height, a last row still being laid out),
 * and calling that "the reader left" is the bug this whole file is about. MEASURED values in
 * the implementations surveyed: 8 (fluxer's exact test), 10 (opencode), 24 (deepseek), 50
 * (open-webui's coarse test), 70 (use-stick-to-bottom's escape hatch). 24 is the middle of the
 * group that also does proper attribution, which is the only comparison that matters — a loose
 * threshold cannot rescue a broken classifier.
 */
export const AT_TAIL_PX = 24;

/**
 * Hysteresis, from fluxer's `DEFAULT_STICKY_TOLERANCE`.
 *
 * Once following, stay following out to this distance. Without it a streaming bubble that
 * momentarily overshoots the floor unpins itself, which reads to the operator as "it stopped
 * following for a second".
 */
export const STICKY_PX = 64;

/** the floor: the largest `scrollTop` that shows the bottom */
export function floorOf(v: Viewport): number {
  return Math.max(0, v.height - v.viewport);
}

/** signed distance to the tail; 0 when the content does not overflow at all */
export function distanceToTail(v: Viewport | null | undefined): number {
  if (!v) return Number.POSITIVE_INFINITY;
  return Math.max(0, v.height - v.top - v.viewport);
}

/** is the tail visible right now? `null` (no viewport mounted) is never at the tail */
export function atTail(v: Viewport | null | undefined, tolerance = AT_TAIL_PX): boolean {
  if (!v) return false;
  return distanceToTail(v) <= tolerance;
}

/**
 * What a scroll delivery means.
 *
 * `reader` is the ONLY outcome that may turn following off. Everything else leaves the state
 * exactly as it was.
 */
export type ScrollCause = "reader" | "programmatic" | "layout";

/**
 * Classify a scroll delivery.
 *
 * @param now       the viewport as delivered
 * @param ledger    the `scrollTop` our last programmatic write produced, plus the height at the
 *                  time. `null` when we have not written since the last delivery.
 * @param lastHeight the content height at the previous delivery, to detect a layout change
 *
 * Order matters, and it is the order that fixes the reported bugs:
 *
 *   1. a height change means LAYOUT — the reader cannot change `scrollHeight`, so any delivery
 *      after one is not evidence about intent
 *   2. a position on `min(ledger, floor)` means OUR WRITE, delivered late, or the browser
 *      clamping after a shrink
 *   3. only then does a position change mean a person
 */
export function classifyScroll(
  now: Viewport,
  ledger: { top: number; height: number } | null,
  lastHeight: number | undefined,
  lastViewport?: number,
): ScrollCause {
  /**
   * 0. THE VIEWPORT changed size. The composer growing or shrinking does exactly this, and it
   *    moves the FLOOR without moving `scrollTop` — so a reader who was at the tail is suddenly
   *    "40px away" without having touched anything. This is the reported bug that survived
   *    three rewrites of the slack constant, because a slack constant cannot express "the
   *    viewport changed"; it can only widen until the case is hidden again.
   */
  if (lastViewport !== undefined && Math.abs(now.viewport - lastViewport) > 0.5) return "layout";
  // 1. the content was resized since the last delivery: this is layout, full stop
  if (lastHeight !== undefined && Math.abs(now.height - lastHeight) > 0.5) return "layout";
  if (ledger) {
    // 2. exactly where our own write put it, or exactly the shrunken floor
    const expected = Math.min(ledger.top, floorOf(now));
    if (Math.abs(now.top - expected) <= 0.5) return "programmatic";
  }
  // 3. a position that is neither our write nor a clamp is a person
  return "reader";
}

/**
 * Should the viewport be pinned to the tail after a change?
 *
 * `following` is INTENT — it is only ever changed from a `reader` cause, or by arriving at the
 * tail. This function does not decide intent; it decides what intent implies for geometry.
 *
 * The hysteresis applies to KEEPING the state, not to acquiring it: arriving at the tail
 * acquires following at `AT_TAIL_PX`, while leaving it needs the reader to be past `STICKY_PX`.
 * That asymmetry is what makes a momentarily-undersized tail not drop follow.
 */
export function shouldPin(following: boolean, v: Viewport): boolean {
  if (!following) return false;
  return distanceToTail(v) <= STICKY_PX;
}

/**
 * The new following state after a delivery.
 *
 * @param following  the intent before this delivery
 * @param cause      the classification above
 * @param v          the viewport as delivered
 */
export function nextFollowing(following: boolean, cause: ScrollCause, v: Viewport): boolean {
  /**
   * A LAYOUT delivery never changes intent; it only re-acquires when the tail is in view.
   *
   * The order matters. This used to test `atTail(v)` FIRST and return true, which meant a
   * reader who wheeled up 40px — still inside the 24px-plus-slack band around the tail — had
   * follow silently re-granted on the very delivery that recorded their move, and the next
   * layout change pinned them back. Reported as "スクロール追従時にユーザーからのスクロールが
   * 無効化される". A person moving away is intent, whatever distance they moved.
   */
  if (cause !== "reader") {
    // our own write, a browser clamp, or a resize: keep the state, but a delivery that lands
    // at the tail (because WE put it there) means the tail is being followed
    return following || atTail(v);
  }
  /**
   * A person moved. Arriving AT the tail (within the acquire tolerance) is them choosing to
   * follow again; anywhere else is them leaving.
   */
  return atTail(v);
}

/**
 * Should the "jump to present" pill be showing?
 *
 * Away from the tail is the whole condition; what makes it worth a control is that new output
 * has arrived since. A reader parked mid-history with nothing new happening does not need to be
 * told about it, and a pill that is always there is furniture.
 */
export function shouldShowJumpToPresent(following: boolean, v: Viewport): boolean {
  return !following && !atTail(v);
}

/** backward-compatible alias: distance from the tail, never negative */
export const gapToTail = distanceToTail;
