import { rememberTextareaHeight, storedTextareaHeight } from "./textarea-size.ts";

/**
 * One owner for a user-resized box's height.
 *
 * Reported: "goalの表示欄が、set goalをしたときに元の高さが尊重されずに何も設定していないときのデフォルトの高さになる
 * 場合がある / たぶん高さの読み込み経路に実装ミスがありそう". The route WAS broken, and it was a two-owner problem
 * again:
 *
 *   - the tracker persisted the dragged height into `localStorage`;
 *   - the JSX re-applied `style={{ ...(stored > 0 ? { height: `${stored}px` } : {}) , ...other }}` on every render.
 *
 * Solid's style binding makes the object authoritative: a property that is ABSENT gets REMOVED from the inline
 * style. So any re-render of that JSX (setting a goal calls `refreshAgents`, which replaces the selected agent
 * object) wrote the style object again — and with `height` absent the browser reverted the box to its content height,
 * i.e. the empty-state default. The stored value was still in `localStorage`, which is why a reload sometimes brought
 * it back and a repro was hard to pin down.
 *
 * So the height is applied IMPERATIVELY here and never appears in a JSX style object. Persisting is also guarded: a
 * measurement equal to the stored height is not a resize, so a re-mount cannot overwrite the operator's choice with
 * the height the browser happened to give the box before the stored one was applied.
 */
/**
 * A measurement is a RESIZE only when the operator has actually grabbed the box.
 *
 * Numbers alone cannot tell the two apart: a box that mounts at its content height (120px) while 300px is stored
 * looks identical to a drag to 120px. What separates them is that a resize starts with a pointer event on the
 * element, so the tracker stays disarmed until then — that is the whole point of the guard.
 */
export function shouldStoreHeight(reported: number, stored: number, armed: boolean): boolean {
  if (!armed) return false;
  if (!Number.isFinite(reported) || reported <= 0) return false;
  if (!Number.isFinite(stored) || stored <= 0) return true;
  return Math.abs(reported - stored) >= 1;
}

/** Apply the remembered height, and remember future ones. Returns a cleanup function. */
export function bindStoredHeight(el: HTMLElement, key: string): () => void {
  const stored = storedTextareaHeight(key);
  if (stored > 0) el.style.height = `${stored}px`;
  let armed = false;
  const arm = () => {
    armed = true;
  };
  el.addEventListener("pointerdown", arm);
  const ro = new ResizeObserver(() => {
    const h = el.offsetHeight;
    if (!shouldStoreHeight(h, storedTextareaHeight(key), armed)) return;
    rememberTextareaHeight(key, h);
  });
  ro.observe(el);
  return () => {
    el.removeEventListener("pointerdown", arm);
    ro.disconnect();
  };
}
