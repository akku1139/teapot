/**
 * Keep a reader's place in a scroll container when the content ABOVE them changes height.
 *
 * Such a container opts out of the engine's anchoring (`overflow-anchor: none` for the feed, whose follow policy owns the
 * position), so nothing moves `scrollTop` when a row above the viewport grows or shrinks and the content slides under the
 * reader. MEASURED: collapsing one tool card above the read position slid the anchor row 382px.
 *
 * The container's DIRECT CHILDREN are the rows. A change is compensated only when the row sat entirely above the viewport
 * top before it changed: a row the reader is looking at is the content they came to see, and moving the viewport for it
 * would be the bug, not the cure.
 *
 * Returns a detach function.
 */
export function attachRowHeightCompensation(opts: {
  container: HTMLElement;
  /** when true, the container follows its tail and owns the position itself */
  isFollowing?: () => boolean;
  /** called after a shift is applied, so the caller can re-baseline its own bookkeeping */
  onShift?: (shift: number) => void;
}): () => void {
  const { container, isFollowing, onShift } = opts;
  if (typeof ResizeObserver === "undefined") return () => {};
  const heights = new Map<Element, number>();
  let observed: Element[] = [];
  const ro = new ResizeObserver((entries) => {
    const following = isFollowing?.() ?? false;
    const box = container.getBoundingClientRect();
    const viewportTop = container.scrollTop;
    let shift = 0;
    for (const e of entries) {
      const el = e.target as Element & { getBoundingClientRect(): DOMRect };
      const after = e.contentRect.height;
      const before = heights.get(el);
      heights.set(el, after);
      if (before === undefined || after === before) continue;
      if (following) continue;
      const top = el.getBoundingClientRect().top - box.top + container.scrollTop;
      if (top + before <= viewportTop) shift += after - before;
    }
    if (!shift) return;
    container.scrollTop = Math.max(0, container.scrollTop + shift);
    onShift?.(shift);
  });
  const sync = () => {
    const rows = [...container.children];
    if (rows.length === observed.length && rows.every((el, i) => el === observed[i])) return;
    for (const el of observed) ro.unobserve(el);
    observed = rows;
    for (const el of rows) {
      if (!heights.has(el)) heights.set(el, el.getBoundingClientRect().height);
      ro.observe(el);
    }
  };
  sync();
  const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => sync());
  mo?.observe(container, { childList: true });
  return () => {
    ro.disconnect();
    mo?.disconnect();
    heights.clear();
    observed = [];
  };
}
