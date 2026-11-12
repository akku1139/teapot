/**
 * How far the reader's position must move when rows ABOVE the viewport change height.
 *
 * `.feed` sets `overflow-anchor: none` on purpose, so no engine compensation happens and `scrollTop` does not change when
 * a row above grows or shrinks — the content then slides under the reader. MEASURED: collapsing one tool card above the
 * read position moved the anchor row from +139px to -243px (a 382px slide) for a 412px -> 30px card.
 *
 * A row contributes its whole delta when it sat ENTIRELY above the viewport top before the change. A row that straddles
 * that line is the one the reader is looking at, so its own height change is the content they came to see and the position
 * must not be moved for it.
 */
export function aboveViewportShift(
  rows: readonly { top: number; before: number; after: number }[],
  viewportTop: number,
): number {
  let shift = 0;
  for (const r of rows) {
    const delta = r.after - r.before;
    if (!delta) continue;
    if (r.top + r.before <= viewportTop) shift += delta;
  }
  return shift;
}
