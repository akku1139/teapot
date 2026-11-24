/**
 * One wheel notch must move three rows (#172, #284).
 *
 * xterm converts a notch as `rows = normalizedDelta × 50 × scrollSensitivity / cellHeight`, and a real notch arrives as
 * `deltaMode: DOM_DELTA_LINE, deltaY: ±3` → `normalizedDelta` 1. With this app's cell (18px) the value 1 is already
 * ≈2.8 rows; the 3 that was here for "three lines per notch" made it 8.3 ≈ 9 rows.
 *
 * The arithmetic is stated here so a future change to the number has to argue with the formula, not with a name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TERMINAL_SCROLL_SENSITIVITY, terminalOptions } from "../frontend/lib/terminal-options.ts";

/** xterm's `SCROLL_WHEEL_SENSITIVITY`, in `scrollableElement.ts`. */
const PIXELS_PER_NORMALIZED_UNIT = 50;

/** The cell height MEASURED in Firefox at `fontSize: 12.5, lineHeight: 1.2`. */
const MEASURED_CELL_HEIGHT = 18;

const rowsPerNotch = (sensitivity: number, cellHeight = MEASURED_CELL_HEIGHT): number =>
  (PIXELS_PER_NORMALIZED_UNIT * sensitivity) / cellHeight;

test("a wheel notch scrolls about three rows, not nine", () => {
  const opts = terminalOptions({});

  const rows = rowsPerNotch(opts.scrollSensitivity);
  assert.ok(rows > 2.5 && rows < 3.5, `one notch should move about three rows; got ${rows}`);
  assert.ok(
    rowsPerNotch(3) > 8,
    "and the value that was here moved more than eight rows — the reported '9行刻み'",
  );
});

test("there is one sensitivity for both buffers", () => {
  assert.equal(TERMINAL_SCROLL_SENSITIVITY, 1);
  assert.equal(terminalOptions({}).scrollSensitivity, TERMINAL_SCROLL_SENSITIVITY);
});
