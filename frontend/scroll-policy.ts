/**
 * Scroll follow, as ONE rule.
 *
 * ## Why this replaces the previous design
 *
 * Follow mode used to be a sticky `atBottom()` signal, flipped by the feed's `onscroll`
 * handler, with ~13 separate call sites each asking their own variation of the question
 * (`if (atBottom()) scrollBottom()`, `if (!atBottom()) return`, `nearBottom()`,
 * `bottomSlack()`, `suppressScrollEval`, `userScrolledUp`, `lastScrollSample`). The bugs
 * that kept coming back all had the same shape: **content can grow without a scroll
 * event**, so anything decided from the last event is stale by the time it is used.
 *
 * Concretely, each of these grows the feed with NO scroll:
 *   - the live bubble streaming a delta;
 *   - the 💭 thinking block growing (its own follow loop);
 *   - a tool row EXPANDING when its result arrives (`open={props.orphan}`);
 *   - `<details>` opening on a click;
 *   - an image finishing load;
 *   - a compaction divider appearing;
 *   - the composer growing a line, which shrinks the viewport.
 *
 * A sticky flag answers "was the reader at the bottom *last time we looked*", which is
 * the wrong question. The right one is: **is the reader at the bottom NOW**, asked at the
 * moment content is about to be added — and "at the bottom" has to be measured with a
 * slack that content growth cannot fake.
 *
 * ## The rule
 *
 *   1. Follow while the reader is at the tail.
 *   2. Stop following the moment they move AWAY from the tail themselves.
 *   3. Growing the content never counts as moving away.
 *
 * (2) and (3) are distinguishable because `scrollTop` decreases only when the reader
 * moves up the content; growth increases `scrollHeight` and leaves `scrollTop` alone.
 * That is `isScrollingAway` in scroll-follow.ts, which stays as-is — it was right.
 *
 * ## What is NOT claimed
 *
 * This module is the DECISION; wiring it is a separate change. It exists so the rule can
 * be tested against every growth case above without a browser, and so the component stops
 * carrying its own copy of the reasoning.
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
 * THE slack, in pixels.
 *
 * A constant on purpose. It used to be `24 + min(composer overflow, 160)`, so the meaning
 * of "at the bottom" changed whenever the composer grew a line — the same jump in
 * coordinates that made follow mode tug at the reader. Content growth is handled by the
 * rule (it never counts as moving away), not by widening the threshold until it fits.
 *
 * 32px: enough for sub-pixel reflow and a one-line composer change; small enough that a
 * deliberate scroll up is detected immediately.
 */
export const TAIL_SLACK_PX = 32;

/** how far above the tail the viewport currently sits (never negative) */
export function gapToTail(s: TailSample): number {
  return Math.max(0, s.height - s.top - s.viewport);
}

/** is the reader at the tail right now? */
export function atTail(s: TailSample | undefined | null, slack = TAIL_SLACK_PX): boolean {
  if (!s) return true; // no element yet: nothing to be away from
  return gapToTail(s) <= slack;
}

/** the scroll offset a "jump to the tail" should set */
export function tailOffset(s: TailSample): number {
  // `scrollTop = scrollHeight` is what the browser clamps to the real maximum, which is
  // also what a reader means by "the bottom"
  return s.height;
}

/**
 * Should the feed scroll to the tail after content changed?
 *
 * Call this AT the point content is added, with geometry read at that moment. The
 * previous design asked a sticky flag instead, which is why growth arriving between
 * scroll events could leave the feed parked.
 *
 * @param wasAtTail the answer from BEFORE the change; used only to decide whether this
 *                  update should follow. A reader who was at the tail and has not moved
 *                  (their `top` is unchanged) still follows.
 */
export function shouldFollowAfterChange(
  before: TailSample | undefined | null,
  after: TailSample,
  slack = TAIL_SLACK_PX,
): boolean {
  if (!before) return true; // first content: land at the tail
  // The reader moved UP since the last measurement, AND content did not shrink. This is
  // the only way to fall out of follow mode.
  //
  // The shrink check matters: when the feed gets SHORTER the browser clamps `scrollTop`
  // down to the new maximum, which looks exactly like a scroll up. Counting that as
  // "away" locked follow off after any compaction, any tool row collapsing, and any
  // session switch to a shorter log — a reader sitting still was treated as having
  // scrolled.
  const shrank = after.height < before.height;
  if (!shrank && after.top < before.top - 1) return false;
  // Otherwise: follow iff they were at the tail before the content grew. After a shrink
  // the clamp leaves them at the new tail, so that test passes on its own.
  return atTail(before, slack) || (shrank && atTail(after, slack));
}

/**
 * The "jump to present" pill: shown when there IS unseen content below and the reader is
 * not at the tail.
 */
export function shouldShowJumpToPresent(s: TailSample | undefined | null, slack = TAIL_SLACK_PX): boolean {
  if (!s) return false;
  return gapToTail(s) > slack;
}
