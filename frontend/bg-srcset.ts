/**
 * Responsive loading for theme background images, in ONE place.
 *
 * The server can serve a wallpaper at several widths (see `src/server/image-resize.ts`), because the
 * original is a multi-megabyte photo and the browser should pick a size that suits the viewport.
 *
 * The app's own wallpaper did this from the start. The appearance panel's preview did NOT — it
 * requested the original file every time the section opened, which is why that panel felt laggy
 * while the rest of the UI did not. Asked as "appearanceがラグくて、なんでだろうって思ったんだけど、
 * こっちはUI本体と違って背景画像がsrcset無しでロードされてる / コンポーネント化しようね".
 *
 * So the ladder and the URL building live here, and every consumer uses them: one definition means a
 * new surface cannot silently load the full-size original.
 */

/**
 * The width ladder, mirroring the server's `ALLOWED_WIDTHS`.
 *
 * Hardcoded rather than fetched so the first paint already has candidates (a fetch would mean one
 * full-size download before any choice exists). Drift degrades rather than breaks: the server
 * rejects an unknown width and the caller falls back to the original.
 */
export const BG_WIDTHS = [640, 1280, 1920, 2560, 3840] as const;

/** the smallest rung — for a thumbnail that never needs anything larger */
export const BG_SMALL = BG_WIDTHS[0];

/**
 * `srcset` for a background image.
 *
 * Returns `undefined` for a missing image so a caller can omit the attribute entirely rather than
 * emit a broken one-word list.
 */
export function bgSrcSet(src?: string): string | undefined {
  if (!src) return undefined;
  return BG_WIDTHS.map((w) => `${src}?w=${w} ${w}w`).join(", ");
}

/**
 * A single URL at a given width.
 *
 * `width` is optional so a caller that just wants "some" image gets the smallest rung — the case
 * that matters is a thumbnail, where asking for the original is the bug.
 */
export function bgSrc(src: string | undefined, width: number = BG_SMALL): string | undefined {
  if (!src) return undefined;
  return `${src}?w=${width}`;
}
