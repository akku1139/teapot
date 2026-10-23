/**
 * A textarea the user can drag taller, remembered across reloads.
 *
 * Two panels needed this and only one had it: the todo editor shipped native resize +
 * `ResizeObserver` + persistence, while the GOAL box was a fixed `rows={3}`. A long goal then owned
 * three lines of a narrow panel permanently — reported as "goalの枠をtodoみたいに伸縮できるようにしない
 * と長いgoalがあるときに画面占有率が強制的に高い".
 *
 * Extracted rather than copied, because the interesting part is not the CSS. The native resize
 * handle writes an INLINE height on the element the browser chose, which does not survive:
 *
 *   - a PREVIEW element replacing the textarea (the todo's checklist view — the drag vanished on
 *     toggle until the height was lifted into a signal both views read);
 *   - a reload.
 *
 * So the height lives in a signal, is written to `localStorage`, and is observed rather than read on
 * `pointerup`: a touch drag or an assistive resize produces no pointer event this code would see.
 */

const KEY_PREFIX = "teapot.textareaH.";

/** the remembered height for a panel, or 0 when untouched */
export function storedTextareaHeight(key: string): number {
  try {
    const n = Number(localStorage.getItem(KEY_PREFIX + key) ?? "");
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** persist a dragged height; sub-pixel churn is ignored by the caller, not here */
export function rememberTextareaHeight(key: string, px: number): void {
  try {
    localStorage.setItem(KEY_PREFIX + key, String(Math.round(px)));
  } catch {
    /* storage full or blocked — the drag still applies for this session */
  }
}

/**
 * Observe an element's height and report changes the user made.
 *
 * Returns the disconnect so the caller can `onCleanup` it. `onHeight` is deliberately called with
 * the LIVE box height, because the resize handle can only be seen through the element's own size.
 */
export function trackTextareaHeight(el: HTMLElement, onHeight: (px: number) => void): () => void {
  const ro = new ResizeObserver(() => {
    const h = el.offsetHeight;
    if (h > 0) onHeight(h);
  });
  ro.observe(el);
  return () => ro.disconnect();
}
