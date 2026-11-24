/**
 * A clipped tool result must end on a LINE boundary (#295).
 *
 * Reported: a long `read_file` ended with a stray `18` — the line number of the next line, whose text was cut away. The
 * gutter is what makes the output addressable, so a fragment of it is worse than nothing: it reads as a line that exists
 * and is empty.
 *
 * The cap is a byte count, which is the wrong unit for text. `clipLines` cuts at the last newline before the cap, so every
 * line it keeps is complete. The fixture width is chosen so the RAW byte cut lands INSIDE a gutter — at most widths it
 * happens to land on a newline, and a test built at one of those would pass against the broken code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clipLines } from "../src/agent/tools.ts";

const GUTTER_WIDTH = 39;
const MAX = 8000;

const gutterText = (): string =>
  Array.from({ length: 600 }, (_, i) => `${String(i + 1).padStart(5)}| ${"x".repeat(GUTTER_WIDTH - 8)}`).join("\n");

test("the fixture really does break the raw byte cut", () => {
  const text = gutterText();
  const head = text.slice(0, MAX);
  const lastKept = head.slice(head.lastIndexOf("\n") + 1);
  assert.match(lastKept, /^\s*\d+$/, `precondition: a byte cut must land inside the gutter; got ${JSON.stringify(lastKept)}`);
});

test("a clipped result ends on a complete line, never mid-gutter", () => {
  const clipped = clipLines(gutterText(), MAX);
  const body = clipped.slice(0, clipped.indexOf("\n... [truncated"));

  const lastLine = body.slice(body.lastIndexOf("\n") + 1);
  assert.match(lastLine, /^\s*\d+\| x+$/, `the last kept line is complete; got ${JSON.stringify(lastLine)}`);
  assert.ok(body.length <= MAX, "and the result does not grow past the cap");
});

test("the marker says how much was kept, and a short text is untouched", () => {
  const text = "  1| short\n  2| text";
  assert.equal(clipLines(text, 100_000), text, "nothing to cut: no marker");

  assert.match(clipLines(gutterText(), MAX), /\n\.\.\. \[truncated at \d+ bytes \/ \d+ total\]$/);
});
