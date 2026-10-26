/**
 * Terminal palette resolution + live re-theming (#137).
 *
 * Extracted from App.tsx so the CURSOR contract is testable by production
 * import: a DOM-less `node --test` runs this module as-is (no solid, no xterm
 * import — plain structural types). The #75 lesson: a test that greps the
 * source cannot see whether the cursor colour is ever SENT, and this exact
 * field was missing on light themes.
 *
 * The cursor is the field the light theme loses: xterm's default cursor does
 * not follow the palette, so a near-black cursor sat on a near-white
 * background. `cursor: foreground` / `cursorAccent: background` is visible on
 * BOTH themes, and stays overridable through `--term-cursor` /
 * `--term-cursor-accent` for themes that want an accent-coloured caret.
 */

/** structural subset of xterm's ITheme we manage (keeps xterm out of tests) */
export interface XtermTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
}

/** structural subset of xterm's Terminal we touch */
export interface XtermLike {
  options: { theme?: XtermTheme | undefined };
}

/** xterm palette pulled from the active theme's CSS variables (fallback: dark) */
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
  } catch { /* non-DOM context */ }
  // #137: name the cursor EXPLICITLY. Defaults follow fg/bg so the caret is
  // visible on light AND dark without every theme block carrying new vars.
  const background = bg || "#0d0e12";
  const foreground = fg || "#dcdee4";
  return {
    background,
    foreground,
    cursor: cursor || foreground,
    cursorAccent: cursorAccent || background,
    /**
     * The text selection, which xterm does NOT derive from the palette.
     *
     * Reported as "ライトテーマでターミナルの選択中の色が背景と同じっぽい". xterm's default selection
     * is a light grey (#FFFFFF at ~30% in some builds, a fixed light highlight in others) — perfectly
     * visible on a dark background and INVISIBLE on `--term-bg: #ffffff`, so a drag looked like it
     * did nothing and a copy had no visible source.
     *
     * Derived rather than themed per palette: a translucent wash of the FOREGROUND gives visible
     * contrast against any background (dark text over white, light text over near-black) without
     * every theme block needing two more variables. Selection TEXT stays the foreground colour, so
     * a token's syntax colour is preserved where xterm allows it.
     */
    selectionBackground: selectionFor(foreground),
    selectionForeground: foreground,
  };
}

/** Re-apply the active theme's terminal palette to a live xterm session (#137). */
export function retintTerminal(s: XtermLike): void {
  const want = themeColors();
  const cur = s.options.theme;
  // the caller's effect runs on any theme signal read, so an unconditional
  // write would churn on unrelated re-renders. #137: the comparison must cover
  // the CURSOR fields too — a theme object that predates them (or a caret left
  // over from the other mode) matches bg/fg and stayed stale forever.
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
  // assigning `options.theme` is xterm's documented way to re-theme a live
  // terminal; it does not disturb the scrollback or the buffer contents
  s.options.theme = want;
}

/**
 * A selection wash that shows up on ANY background.
 *
 * The foreground colour at ~28% is the trick: on a white terminal that is a soft grey band behind
 * dark text, on a near-black one it is a light band behind pale text. A FIXED colour cannot do both,
 * which is why the default failed on light themes only.
 *
 * Alpha needs a hex-with-alpha (`#rrggbbaa`, which xterm accepts); an `rgb()` string would need
 * parsing, and a `var()` cannot be resolved here because this runs outside CSS.
 */
export function selectionFor(foreground: string): string {
  const hex = foreground.trim();
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m) return `#${m[1]}47`; // 0x47 ≈ 28% opacity
  // a non-hex colour (or empty): fall back to a mid grey that reads on both extremes
  return "rgba(128, 128, 128, 0.35)";
}
