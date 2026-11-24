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

/**
 * Wheel sensitivity, in the unit xterm actually uses.
 *
 * The name suggests "lines per notch", so 3 looked like the way to get three lines. It is a MULTIPLIER inside xterm's
 * scroll conversion:
 *
 *     pixels = normalizedDelta × 50 × scrollSensitivity      // SCROLL_WHEEL_SENSITIVITY = 50
 *     rows   = round(pixels / cellHeight)
 *
 * A real mouse notch arrives as `deltaMode: DOM_DELTA_LINE, deltaY: ±3`, which xterm normalizes to ±1; with the default
 * cell height of 18px the default sensitivity of 1 is already **2.8 ≈ 3 rows**. Setting 3 tripled the pixels, so one notch
 * jumped 8.3 ≈ 9 rows ("ターミナルのスクロールが9行刻みになってる").
 *
 * 1 therefore IS "three lines per notch" at this cell height. There is no per-buffer difference to make any more: the
 * alt buffer scrolls by rows too, so the same value is correct there, and the sensitivity no longer has to be reassigned
 * when the buffer switches.
 */
export const TERMINAL_SCROLL_SENSITIVITY = 1;

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
    scrollSensitivity: TERMINAL_SCROLL_SENSITIVITY,
    fontFamily: "ui-monospace, Menlo, Consolas, monospace",
    // xterm only honours a translucent theme background with this on
    allowTransparency: true,
    theme,
  };
}
