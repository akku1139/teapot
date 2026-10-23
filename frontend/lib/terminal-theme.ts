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
  return {
    background: bg || "#0d0e12",
    foreground: fg || "#dcdee4",
    cursor: cursor || fg || "#dcdee4",
    cursorAccent: cursorAccent || bg || "#0d0e12",
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
    cur.cursorAccent === want.cursorAccent
  ) {
    return;
  }
  // assigning `options.theme` is xterm's documented way to re-theme a live
  // terminal; it does not disturb the scrollback or the buffer contents
  s.options.theme = want;
}
