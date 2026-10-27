import { renderMarkdown } from "../md";

/**
 * Rendered markdown, cached by SOURCE TEXT.
 *
 * That key is the whole message body, so a tool result of 8,000 chars costs its own 16KB plus the
 * roughly 1.6x that the HTML occupies — 500 entries of those is over 20MB retained for text that may
 * never scroll into view again (#186). The cap is on BYTES now, and the entry count stays as a second
 * bound for the many-small-messages case.
 */
const mdCache = new Map<string, string>();
let mdCacheBytes = 0;
const MD_CACHE_MAX_ENTRIES = 500;
const MD_CACHE_MAX_BYTES = 4 * 1024 * 1024;

export function renderMarkdownCached(src: string): string {
  const hit = mdCache.get(src);
  if (hit !== undefined) return hit;
  const html = renderMarkdown(src);
  mdCache.set(src, html);
  mdCacheBytes += (src.length + html.length) * 2;
  while ((mdCache.size > MD_CACHE_MAX_ENTRIES || mdCacheBytes > MD_CACHE_MAX_BYTES) && mdCache.size) {
    const oldest = mdCache.keys().next().value;
    if (oldest === undefined) break;
    const gone = mdCache.get(oldest) ?? "";
    mdCacheBytes -= (oldest.length + gone.length) * 2;
    mdCache.delete(oldest);
  }
  return html;
}
