/**
 * The xterm option bag, kept in one testable place.
 *
 * Reported (#232): "xtermで文字の上側が切れる" — at Chrome's 90% zoom, `fontSize: 12.5` with xterm's default `lineHeight: 1`
 * lays each glyph in a line box exactly as tall as the font's em box, and a monospace whose ascent is larger than its em
 * paints the top of `b`, `f`, `{` outside the cell: the canvas clips it.
 *
 * `lineHeight` is the knob for that (xterm multiplies the cell height by it), so the cell is taller than the glyph and the
 * clipping is gone. 1.2 is the smallest step that clears the ascent on the fonts this app lists, and it does not push the
 * row count down much.
 */
export const TERMINAL_LINE_HEIGHT = 1.2;

export function terminalOptions<T>(theme: T): {
  cursorBlink: boolean;
  fontSize: number;
  lineHeight: number;
  scrollSensitivity: number;
  fontFamily: string;
  allowTransparency: boolean;
  theme: T;
} {
  return {
    cursorBlink: true,
    fontSize: 12.5,
    lineHeight: TERMINAL_LINE_HEIGHT,
    /**
     * Three lines per wheel notch.
     *
     * The default is ONE line per notch, which on a 40-row drawer is 40 notches for a screenful — reported as
     * "スクロールが1行ずつで遅い" (#172). (Shift+wheel already jumps a page through xterm's built-in
     * `fastScrollModifier` handling; the option itself is not in this version's option type, so only the sensitivity is
     * set here.)
     */
    scrollSensitivity: 3,
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    // xterm only honours a translucent theme background with this on
    allowTransparency: true,
    theme,
  };
}
