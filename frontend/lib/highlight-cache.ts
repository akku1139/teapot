/**
 * A bounded cache of highlighted markup, keyed by CONTENT.
 *
 * It is module-level on purpose: an instance-local signal is discarded whenever a row's subtree is
 * rebuilt, and the rebuilt instance then has to race the grammar download again — which is why the
 * same command rendered highlighted on one row and plain on another.
 */

const MAX = 400;
const cache = new Map<string, string>();

export function highlightedHtml(key: string): string | undefined {
  return cache.get(key);
}

export function cacheHighlighted(key: string, html: string): void {
  if (cache.size >= MAX) {
    // Map preserves insertion order, so this drops the oldest entry
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, html);
}

/** test seam: the size, so a bound can be asserted without reaching into the map */
export function highlightCacheSize(): number {
  return cache.size;
}
