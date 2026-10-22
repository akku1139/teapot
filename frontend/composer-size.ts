/**
 * The height to give a textarea so it exactly fits its content.
 *
 * ## Why this cannot be computed from a fixed-height box
 *
 * A textarea with an explicit height reports `max(its height, its content)` as `scrollHeight`.
 * MEASURED: a 60px box holding one line of text reports 60 — there is NO expression on that
 * element that yields 20. So the content height is unrecoverable while the box is taller than
 * its content, and the only way to read it is to let the box collapse first.
 *
 * Three attempts tried to avoid the collapse by comparing numbers on the fixed-height box, and
 * each failed for this same reason:
 *
 *   v0.34.7  `contentHeight <= offsetHeight` — always true at 1, 2 and 3 lines.
 *   v0.34.8  compared against a remembered content height, but read it from a box that was
 *            still tall, so the remembered value was the BOX height.
 *   v0.35.10 compared `scrollHeight` against the content height last applied. On shrink the two
 *            are equal (both are the box), so a shrink was never detected and the box never
 *            came back down — reported as "広がった入力枠が Ctrl+A Backspace もしくは中身を全部
 *            けさないともとに戻らない".
 *
 * So the collapse is REQUIRED. What has to be right is everything around it: the feed must not
 * treat the transient one-line layout as a real box change (it re-pins on every box change, so
 * the collapsed floor is pinned and then corrected — see `restoreAfterBoxChange`).
 *
 * @param scrollHeight the content height measured with the box at `height: auto`
 * @param maxHeight    the cap; past this the box scrolls instead of growing
 */
export function composerHeight(scrollHeight: number, maxHeight: number): number {
  // a textarea always paints at least one line, even with no content
  return Math.max(1, Math.min(scrollHeight, maxHeight));
}
