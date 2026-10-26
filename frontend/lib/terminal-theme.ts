
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

export function themeColors(): XtermTheme {
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
  const background = bg || "#0d0e12";
  const foreground = fg || "#dcdee4";
  return {
    background,
    foreground,
    cursor: cursor || foreground,
    cursorAccent: cursorAccent || background,
    selectionBackground: selectionFor(foreground),
    selectionForeground: foreground,
  };
}

export function retintTerminal(s: XtermLike): void {
  const want = themeColors();
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
