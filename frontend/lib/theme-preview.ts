
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

export function backgroundImageValue(image?: string): string | undefined {
  const v = image?.trim();
  if (!v) return undefined;
  return `url("${v.replace(/"/g, "%22")}")`;
}
