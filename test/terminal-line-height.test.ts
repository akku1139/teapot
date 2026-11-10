/**
 * The terminal cell must be taller than the glyph (#232).
 *
 * "xtermで文字の上側が切れる" at Chrome's 90% zoom: `fontSize: 12.5` with xterm's default `lineHeight: 1` gives a line box
 * exactly as tall as the em box, and a monospace whose ascent exceeds it paints the top of `b`/`f`/`{` outside the cell,
 * where the canvas clips it. `lineHeight` multiplies the cell, so the glyph fits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TERMINAL_LINE_HEIGHT, terminalOptions } from "../frontend/lib/terminal-options.ts";

test("the terminal row is taller than its font", () => {
  const opts = terminalOptions({ background: "#000" });
  assert.ok(opts.lineHeight > 1, `lineHeight must exceed 1 or the ascent is clipped; got ${opts.lineHeight}`);
  assert.equal(opts.lineHeight, TERMINAL_LINE_HEIGHT);
  assert.ok(TERMINAL_LINE_HEIGHT >= 1.15, "1.0 clips; 1.2 is the smallest step that clears the ascent on these fonts");
});

test("the options the terminal depends on are all still set", () => {
  const opts = terminalOptions({ background: "#000" });
  assert.equal(opts.cursorBlink, true);
  assert.ok(opts.fontSize > 0);
  assert.equal(opts.scrollSensitivity, 3, "#172: three lines per wheel notch");
  assert.equal(opts.allowTransparency, true, "xterm ignores a translucent theme background without it");
  assert.equal(opts.theme.background, "#000", "the caller's theme is passed through unchanged");
});
