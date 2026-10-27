import { sizedAsset } from "./bg-srcset.ts";

export interface PreviewLayers {
  dim: number;
  panel: number;
  raised: number;
}

const DEFAULT_ALPHA = 0.82;
const DEFAULT_DIM = 0.9;

const clamp01 = (n: number): number | undefined => {
  if (!Number.isFinite(n)) return undefined;
  return n < 0 ? 0 : n > 1 ? 1 : n;
};

export function previewLayers(surfaceAlpha?: number, backgroundDim?: number): PreviewLayers {
  const base = clamp01(surfaceAlpha ?? DEFAULT_ALPHA) ?? DEFAULT_ALPHA;
  const dim = clamp01(backgroundDim ?? DEFAULT_DIM) ?? DEFAULT_DIM;
  return {
    dim,
    panel: Math.max(0, Math.min(1, base - 0.05)),
    raised: Math.max(0, Math.min(1, base + 0.06)),
  };
}

export function veilColour(surface: string, dim: number): string {
  const pct = Math.round((clamp01(dim) ?? DEFAULT_DIM) * 100);
  return `color-mix(in srgb, ${surface} ${pct}%, transparent)`;
}

/**
 * The wallpaper layer of a theme PREVIEW, at the size the preview is drawn.
 *
 * The cards are `62px` tall and a couple of hundred wide, so asking for the full image meant opening
 * `appearance` fetched every theme's wallpaper at its original resolution — "appearanceを開くとバカ重い".
 * The asset endpoint already downsizes on demand (`?w=`, cached as `name-w640.ext`), so the preview
 * asks for the smallest variant and the operator's bandwidth is spent on something they can see.
 */
export function backgroundImageValue(image?: string, width?: number): string | undefined {
  const v = image?.trim();
  if (!v) return undefined;
  const src = width ? sizedAsset(v, width) ?? v : v;
  return `url("${src.replace(/"/g, "%22")}")`;
}
