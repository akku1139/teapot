
export const BG_WIDTHS = [640, 1280, 1920, 2560, 3840] as const;

export const BG_SMALL = BG_WIDTHS[0];

export function bgSrcSet(src?: string): string | undefined {
  if (!src) return undefined;
  return BG_WIDTHS.map((w) => `${src}?w=${w} ${w}w`).join(", ");
}

export function bgSrc(src: string | undefined, width: number = BG_SMALL): string | undefined {
  if (!src) return undefined;
  return `${src}?w=${width}`;
}
