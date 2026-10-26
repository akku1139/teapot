
const KEY_PREFIX = "teapot.textareaH.";

export function storedTextareaHeight(key: string): number {
  try {
    const n = Number(localStorage.getItem(KEY_PREFIX + key) ?? "");
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function rememberTextareaHeight(key: string, px: number): void {
  try {
    localStorage.setItem(KEY_PREFIX + key, String(Math.round(px)));
  } catch {
  }
}

export function trackTextareaHeight(el: HTMLElement, onHeight: (px: number) => void): () => void {
  const ro = new ResizeObserver(() => {
    const h = el.offsetHeight;
    if (h > 0) onHeight(h);
  });
  ro.observe(el);
  return () => ro.disconnect();
}
