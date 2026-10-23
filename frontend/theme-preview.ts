/**
 * How a theme preview composes its wallpaper and its panels.
 *
 * #theme-preview: the cards preview a theme's PALETTE, so a custom theme carrying a background image
 * previewed as a flat palette — two themes differing only by wallpaper looked identical, and a theme
 * with an image looked like it had none. Asked for as "テーマカードに背景画像(透過設定付きで)も出すよう
 * になると嬉しい / その場合、下側の背景透過と重複しないようにしないといけない".
 *
 * That second clause is the real constraint: the app dims the photo with a veil and then paints
 * translucent panels over it, so a preview that applied the dim AND the panel opacity would darken
 * twice — it would show a surface considerably denser than the app ever does. This module therefore
 * returns the two in the order the real stylesheet applies them (veil first, panels after), and the
 * caller renders them as separate layers rather than mixing one colour.
 *
 * Pure and dependency-free so it is unit-testable under `node --test`.
 */

export interface PreviewLayers {
  /** opacity of the veil painted directly over the wallpaper, 0 = none */
  dim: number;
  /** opacity of each simulated panel (sidebar, header, content surface) */
  panel: number;
  /** opacity of the raised content surface, which the app paints one step denser */
  raised: number;
}

/** the app's own defaults, matching `app.css` (`--surface-alpha` 0.82, panels one step below) */
const DEFAULT_ALPHA = 0.82;
const DEFAULT_DIM = 0.9;

/**
 * Clamp to [0,1], treating a non-finite value as "unset".
 *
 * `NaN` must not become 0: a preview at zero opacity is an INVISIBLE tile, and a broken stored theme
 * would then look like a rendering bug. Returning `undefined` lets the caller apply its default.
 */
const clamp01 = (n: number): number | undefined => {
  if (!Number.isFinite(n)) return undefined;
  return n < 0 ? 0 : n > 1 ? 1 : n;
};

/**
 * The layer opacities to draw.
 *
 * `surfaceAlpha` is the operator's slider: high means dense surfaces. The real stylesheet puts the
 * panel one step BELOW the base (`--surface-alpha − 0.05`) and raises the content surface above it
 * (`+ 0.06`), so the preview mirrors that ordering — a preview whose panels were denser than the
 * app's would make every theme look more opaque than it is.
 */
export function previewLayers(surfaceAlpha?: number, backgroundDim?: number): PreviewLayers {
  const base = clamp01(surfaceAlpha ?? DEFAULT_ALPHA) ?? DEFAULT_ALPHA;
  const dim = clamp01(backgroundDim ?? DEFAULT_DIM) ?? DEFAULT_DIM;
  return {
    dim,
    // `base` is already a finite number in [0,1], so these stay in range without re-clamping
    panel: Math.max(0, Math.min(1, base - 0.05)),
    raised: Math.max(0, Math.min(1, base + 0.06)),
  };
}

/**
 * A veil colour for the wallpaper layer.
 *
 * The app's veil is `color-mix(--bg-dark, dim)`, i.e. it TINTS toward the theme's own surface rather
 * than darkening: a light theme with a photo behind it must get a LIGHT veil, or the panels around
 * it look like they float on a black page. Returning the mix here (instead of a fixed black overlay)
 * keeps that direction, which was a reported bug in the app itself.
 */
export function veilColour(surface: string, dim: number): string {
  const pct = Math.round((clamp01(dim) ?? DEFAULT_DIM) * 100);
  // `color-mix` degrades to the untinted surface where unsupported, which is still readable
  return `color-mix(in srgb, ${surface} ${pct}%, transparent)`;
}
