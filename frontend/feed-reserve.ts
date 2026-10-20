/**
 * Reserve each feed row's REAL height as its `contain-intrinsic-size`.
 *
 * ## The problem being solved
 *
 * `content-visibility: auto` (see app.css, #143) skips layout for rows outside the
 * viewport, using `contain-intrinsic-size` as a placeholder. When a skipped row scrolls
 * into view the browser lays it out for real — and if the real height differs from the
 * placeholder, everything ABOVE it shifts, so the scroll position moves under the reader.
 *
 * MEASURED row heights here vary by three orders of magnitude (message median 105 chars,
 * max 1186; tool_result median 279, max 8000), so no single guess is right: `auto 140px`
 * leaves ~50px of error on a typical message and ~80px on the p95 row, multiplied by every
 * skipped row above. That is the Firefox report — Chromium happens not to report the shift
 * as CLS (crbug 40733057), which is why it went unnoticed there.
 *
 * ## The fix
 *
 * Alex Russell documented it in "Resize-Resilient `content-visibility` Fixes"
 * (infrequently.org/2020/12/resize-resilient-deferred-rendering/):
 *
 *   > leave the flow alone and use IntersectionObservers and ResizeObservers to reserve
 *   > vertical space using CSS's new contain-intrinsic-size property once elements have
 *   > been laid out.
 *
 * Once a row has been laid out we KNOW its height, so we tell the browser that exact
 * number. Re-visiting it later then changes nothing and the scroll position holds. It is a
 * progressive enhancement: `contain-intrinsic-size` is only a hint, and a browser without
 * it behaves as before.
 *
 * Two observers, both cheap (they fire post-layout):
 *   - **IntersectionObserver** with a skirt, so rows just outside the viewport get measured
 *     BEFORE they are scrolled to — that is the moment the height must already be right.
 *     Without the skirt we would measure the row at the instant it unskips, which is too
 *     late: the shift has already happened.
 *   - **ResizeObserver**, because a row's height changes while on screen (a `<details>`
 *     opening, a tool result arriving, an image loading). Without this the reserved value
 *     goes stale and the NEXT revisit shifts.
 *
 * `auto` is deliberately NOT used in the reserved value: `auto` makes the browser remember
 * the size of a row it once laid out, which is the behaviour we are replacing. Writing an
 * explicit pixel value is what makes the reservation authoritative.
 */

/** how far outside the viewport to measure, so a row is exact before it is reached */
const SKIRT_PX = 900;

export interface ReservedSizes {
  /** stop observing; safe to call twice */
  disconnect: () => void;
  /** how many rows currently carry a reserved size (for tests and diagnostics) */
  size: () => number;
}

/**
 * Reserve measured heights for every row in `root`.
 *
 * @param root      the scroll container (`.feed`) — rows are its `[data-eid]` children
 * @param onReserve called after a reservation is written, so a caller can react (the smoke
 *                  harness uses it to assert; the app does not need it)
 */
export function reserveRowSizes(root: HTMLElement, onReserve?: () => void): ReservedSizes {
  const reserved = new WeakMap<HTMLElement, { w: number; h: number }>();
  const known = new Set<HTMLElement>();
  /** rows already handed to the observers, so `adoptAll` is a membership test */
  const adopted = new Set<HTMLElement>();

  /** write the measured box back as the row's placeholder, if it changed meaningfully */
  const reserve = (el: HTMLElement, box: { width: number; height: number }) => {
    // a zero box means "not laid out yet" (or a detached node) — reserving 0 would make the
    // row collapse on its next skip, which is worse than the default guess
    if (box.height <= 0) return;
    // ROUND FIRST, and compare only the rounded values (#177). IntersectionObserver reports
    // a FRACTIONAL `boundingClientRect` while ResizeObserver's `offsetHeight` is an INTEGER,
    // so the same row measured by both produced e.g. 137.6 then 138 — always ≥1px apart,
    // never settling. Each write to `contain-intrinsic-size` can itself trigger a resize, so
    // the two together could alternate forever. Rounding makes both agree on the same row.
    box = { width: Math.round(box.width), height: Math.round(box.height) };
    if (box.height <= 0) return;
    const prev = reserved.get(el);
    // 1px of hysteresis: sub-pixel reflow would otherwise rewrite a style on every frame
    if (prev && Math.abs(prev.h - box.height) < 1 && Math.abs(prev.w - box.width) < 1) return;
    reserved.set(el, { w: box.width, h: box.height });
    known.add(el);
    // `width height` — the width is reserved too because a re-wrap changes the height
    el.style.setProperty("contain-intrinsic-size", `${box.width}px ${box.height}px`);
    onReserve?.();
  };

  /**
   * Rows adopted in the current batch, measured together (see `flushMeasure()`).
   *
   * #178: measuring each row as it was adopted meant `getBoundingClientRect()` → write style →
   * `getBoundingClientRect()` → write style, once per row. On a large session (~16,600 rows)
   * that is ~16,600 forced reflows — layout thrashing — and it ran on load, which is why the
   * UI was unusable on open.
   */
  let pending: HTMLElement[] = [];
  /** read ALL pending boxes first, then write ALL reservations: one layout flush per batch */
  const flushMeasure = () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const boxes = batch.map((el) => el.getBoundingClientRect()); // reads only
    for (let i = 0; i < batch.length; i++) reserve(batch[i]!, boxes[i]!); // writes only
  };
  const observe = (el: HTMLElement) => {
    // queued: the caller (`adoptAll` / the MutationObserver callback) flushes the whole batch
    // once, so this never reads layout per row.
    pending.push(el);
  };

  const io =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) reserve(e.target as HTMLElement, e.boundingClientRect);
          },
          // a tall skirt: rows are measured while still off-screen, so the reservation is in
          // place BEFORE the scroll reaches them
          { root, rootMargin: `${SKIRT_PX}px 0px ${SKIRT_PX}px 0px` },
        )
      : null;

  const ro =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver((entries) => {
          for (const e of entries) {
            const el = e.target as HTMLElement;
            // `contentRect` excludes padding; use the border box, which is what a
            // placeholder has to match (`.msg` has vertical padding)
            reserve(el, { width: el.offsetWidth, height: el.offsetHeight });
          }
        })
      : null;

  /**
   * Adopt any row that is not yet observed.
   *
   * Called on every observer callback, so it is cheap (a query plus a membership test) and
   * self-healing: whatever the DOM looks like when an observer fires, every row in it ends
   * up observed. That is more reliable than trying to catch the exact render tick — MEASURED
   * in the smoke harness, one snapshot caught 5 of 10 rows, and the rest would have kept the
   * stylesheet's guess forever.
   */
  const adopt = (el: HTMLElement) => {
    if (adopted.has(el)) return;
    adopted.add(el);
    observe(el);
    io?.observe(el);
    ro?.observe(el);
  };
  /**
   * Adopt every row currently in the DOM.
   *
   * NOT called from the observers. #177: it was, which made each scroll frame or resize do
   * a `querySelectorAll` over every row and then a Set membership test for each — on a long
   * feed that is a full DOM query per frame, for a result that can only change when the DOM
   * changes. The MutationObserver below already reports exactly that, so adoption happens
   * when a row is ADDED and nowhere else.
   */
  const adoptAll = () => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-eid]")) adopt(el);
    flushMeasure();
  };
  adoptAll();

  /**
   * Watch for rows that appear LATER.
   *
   * A MutationObserver on the container (childList only, so it does not fire for the text
   * changes streaming produces) plus `adoptAll` covers rows added between renders.
   */
  const mo =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver((records) => {
          for (const r of records) {
            for (const node of r.addedNodes) {
              // `nodeType === 1` rather than `instanceof Element`: the module is also loaded
              // in harnesses and workers where the `Element` global is not defined, and the
              // `instanceof` check threw there (a ReferenceError inside the observer)
              if ((node as Node).nodeType !== 1) continue;
              const el = node as HTMLElement;
              if (el.matches?.("[data-eid]")) adopt(el);
              // a wrapper row can carry rows
              for (const inner of el.querySelectorAll?.<HTMLElement>("[data-eid]") ?? []) adopt(inner);
            }
          }
          // one batched measurement for everything this callback adopted
          flushMeasure();
        })
      : null;
  mo?.observe(root, { childList: true, subtree: true });

  let live = true;
  return {
    disconnect() {
      if (!live) return;
      live = false;
      io?.disconnect();
      ro?.disconnect();
      mo?.disconnect();
    },
    size: () => known.size,
  };
}
