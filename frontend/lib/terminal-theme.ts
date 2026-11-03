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

/**
 * The alpha the code-block surface is actually painted with, read from a real element.
 *
 * The custom property holds `max(.35, calc(.82 - .12))` — an expression, not a number — so `parseFloat` on it
 * fails and the terminal would silently fall back to a hard-coded value while the code blocks used the
 * operator's setting. Measuring a probe that is painted with `var(--bg-darkest)` reads the RESOLVED colour, so
 * the two surfaces always agree no matter what the theme editor's slider says.
 *
 * Returns 1 when the value cannot be resolved: opaque is the safe answer (it cannot make text unreadable).
 */
export function surfaceAlphaFromDom(doc: Document = document): number {
  const view = doc.defaultView;
  if (!view) return 1;
  const probe = doc.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:0;height:0;background-color:var(--bg-darkest)";
  doc.body.appendChild(probe);
  try {
    const bg = view.getComputedStyle(probe).backgroundColor ?? "";
    const slash = /\/\s*([\d.]+)\s*\)/.exec(bg);
    if (slash) {
      const a = Number.parseFloat(slash[1]!);
      return Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1;
    }
    const rgba = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/i.exec(bg.trim());
    if (rgba) {
      const a = Number.parseFloat(rgba[1]!);
      return Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1;
    }
    // `rgb(...)` with no alpha means the surface is opaque
    return 1;
  } finally {
    probe.remove();
  }
}
