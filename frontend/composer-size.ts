/**
 * Should the composer re-measure itself by collapsing to `height: auto`?
 *
 * A textarea with a fixed height reports `max(its own height, its content)` as `scrollHeight`,
 * so while the box is taller than its content the CONTENT height is unrecoverable — the only way
 * to read it is to collapse the box first. That round-trip is a real layout at one line, and it
 * is visible: `.feed` is a flex sibling, so the collapse grows the feed by the difference, and
 * the scroll policy cannot tell that box change from the reader moving.
 *
 * It is therefore taken only when it is the ONLY way to get the number — i.e. when the content
 * got SHORTER. In every other case `scrollHeight` already reports what we need:
 *
 *   - content GREW (a new wrapped line): the box has not caught up yet, so `scrollHeight` is
 *     the content height. Nothing to measure.
 *   - content unchanged (typing inside an existing line): ditto.
 *
 * Reported as "2行以上の入力欄に入力するとタイムラインのスクロールが1行目の高さに合わせて戻る".
 * It reproduced in Firefox first and later in Chrome; the engine never mattered, because the
 * drift came from this round-trip, not from scroll anchoring.
 *
 * MEASURED why the earlier attempt at this guard was wrong: it compared `scrollHeight` to the
 * box's `offsetHeight`, which is true at one, two and three lines alike — the collapse stayed
 * unconditional. The comparison that works is against the content height we LAST APPLIED.
 *
 * @param scrollHeight      `scrollHeight` as read, before any collapse
 * @param lastAppliedContentH the content height written on the previous call (0 when empty)
 * @param maximized         the box is expanded to a fixed tall size, so it never auto-sizes
 */
export function needsRemeasure(
  scrollHeight: number,
  lastAppliedContentH: number,
  maximized: boolean,
): boolean {
  // maximising sets an explicit height unrelated to content; always re-measure there
  if (maximized) return true;
  // a sub-pixel difference is rounding, not a shrink — treating it as one causes a needless
  // collapse on nearly every keystroke, which is the whole bug this function exists to avoid
  return scrollHeight < lastAppliedContentH - 0.5;
}
