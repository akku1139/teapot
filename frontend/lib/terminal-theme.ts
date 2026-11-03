export interface XtermTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
}

export interface XtermLike {
  options: { theme?: XtermTheme | undefined };
}

/**
 * Give a colour an alpha, so the terminal can sit ON the wallpaper instead of over it.
 *
 * xterm paints its own background, so "make the terminal translucent" is a theme value, not a CSS rule: with an
 * opaque `--term-bg` the surface covers the image no matter what the surrounding elements do. Only the colour
 * the theme already chose is kept and its alpha lowered, so the palette still decides the hue.
 */
export function withAlpha(colour: string, alpha: number): string {
  if (alpha >= 1) return colour;
  const hex = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(colour.trim());
  if (rgb) {
    const parts = rgb[1]!.split(",").map((p) => p.trim());
    const [r, g, b] = parts;
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
  }
  return colour;
}

export function themeColors(alpha = 1): XtermTheme {
  let bg = "";
  let fg = "";
  let cursor = "";
  let cursorAccent = "";
  try {
    const cs = getComputedStyle(document.documentElement);
    bg = cs.getPropertyValue("--term-bg").trim();
    fg = cs.getPropertyValue("--term-fg").trim();
    cursor = cs.getPropertyValue("--term-cursor").trim();
    cursorAccent = cs.getPropertyValue("--term-cursor-accent").trim();
  } catch {  }
  const base = bg || "#0d0e12";
  const background = withAlpha(base, alpha);
  const foreground = fg || "#dcdee4";
  return {
    background,
    foreground,
    cursor: cursor || foreground,
    cursorAccent: cursorAccent || base,
    selectionBackground: selectionFor(foreground),
    selectionForeground: foreground,
  };
}

export function retintTerminal(s: XtermLike, alpha = 1): void {
  const want = themeColors(alpha);
  const cur = s.options.theme;
  if (
    cur &&
    cur.background === want.background &&
    cur.foreground === want.foreground &&
    cur.cursor === want.cursor &&
    cur.cursorAccent === want.cursorAccent &&
    cur.selectionBackground === want.selectionBackground
  ) {
    return;
  }
  s.options.theme = want;
}

export function selectionFor(foreground: string): string {
  const hex = foreground.trim();
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m) return `#${m[1]}47`;
  return "rgba(128, 128, 128, 0.35)";
}
