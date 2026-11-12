/**
 * A full-screen program must get ONE line per wheel notch (#172).
 *
 * `scrollSensitivity: 3` was added because one line per notch is slow when reading output. In the alt buffer (nano, vim, less)
 * xterm translates the wheel into cursor-up/down sequences, so three lines per notch became three LINES PER KEY and nano
 * jumped three lines at a time — "ターミナルでnanoだけ3行刻みでスクロールできない".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { scrollSensitivityFor, terminalOptions } from "../frontend/lib/terminal-options.ts";

test("a full-screen program gets one line per notch, scrollback gets three", () => {
  assert.equal(scrollSensitivityFor("alternate"), 1, "nano/vim/less: the wheel is a key press");
  assert.equal(scrollSensitivityFor("normal"), 3, "reading output: three lines per notch");
});

test("the option bag still starts at the scrollback value", () => {
  assert.equal(terminalOptions({}).scrollSensitivity, 3);
});
