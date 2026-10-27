/**
 * Every width the asset endpoint will resize to — it validates `?w=` against the same list, so the two
 * must agree or a request 400s.
 *
 * 320 is the floor because the background-image picker is 260px wide and the theme cards are ~200px:
 * with a 640 minimum the browser fetched 2.5x the pixels it could display ("260pxなのに最小が640w").
 */
export const BG_WIDTHS = [320, 640, 1280, 1920, 2560, 3840] as const;

export const BG_SMALL = BG_WIDTHS[0];

/**
 * Only OUR asset URLs can be asked for a different width.
 *
 * `/api/assets/<32 hex>.<ext>` is served by `api.ts`, which downsizes on demand and caches
 * `name-w640.ext` beside the original; `?w=` on anything else is meaningless (a remote URL would just
 * get a junk query string, and a `data:` URL would break).
 */
const ASSET_URL = /^\/api\/assets\/[a-f0-9]{32}\.(png|jpg|jpeg|gif|webp|avif)$/i;

export function sizedAsset(src: string | undefined, width: number): string | undefined {
  if (!src) return undefined;
  return ASSET_URL.test(src) ? `${src}?w=${width}` : src;
}

export function bgSrcSet(src?: string): string | undefined {
  if (!src) return undefined;
  return BG_WIDTHS.map((w) => `${sizedAsset(src, w)} ${w}w`).join(", ");
}

export function bgSrc(src: string | undefined, width: number = BG_SMALL): string | undefined {
  return sizedAsset(src, width);
}
