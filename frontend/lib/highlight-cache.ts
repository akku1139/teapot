
const MAX = 400;
const cache = new Map<string, string>();

export function highlightedHtml(key: string): string | undefined {
  return cache.get(key);
}

export function cacheHighlighted(key: string, html: string): void {
  if (cache.size >= MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, html);
}

export function highlightCacheSize(): number {
  return cache.size;
}
