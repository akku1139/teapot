import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * No tool row may truncate its arguments or its output.
 *
 * The operator's rule: a tool card is ALREADY a `<details>`, so opening it IS the request to see the
 * content, and `.toolbody` scrolls vertically. A second limit inside an explicit open discards what was
 * just asked for. Measured inconsistency this replaced: `bash` and `edit_file` showed everything while
 * `write_file` cut its content at 1500 chars ("open it from 🗂 files for the full view") and
 * `apply_patch` showed 60 lines with "… N more lines".
 *
 * This is a SOURCE check, which the repo otherwise forbids — the exception is deliberate and narrow:
 * the property here is "no truncating call appears in these blocks", which is a fact about the
 * rendered contract that a DOM test cannot state (a short fixture never truncates, so a value test
 * passes vacuously and the next author re-adds the cap).
 */
const ROWS = path.join(import.meta.dirname, "..", "frontend", "components", "rows.tsx");

const blockOf = (src: string, tool: string): string => {
  const start = src.indexOf(`case "${tool}":`);
  assert.ok(start >= 0, `${tool} must still have a case in the tool row renderer`);
  const next = src.indexOf('case "', start + 10);
  return src.slice(start, next > 0 ? next : src.length);
};

test("every tool row renders its arguments and output in full (#snip)", () => {
  const src = readFileSync(ROWS, "utf8");
  for (const tool of ["bash", "read_file", "write_file", "edit_file", "apply_patch"]) {
    const block = blockOf(src, tool);
    assert.doesNotMatch(block, /\btruncate\(/, `${tool} must not truncate`);
    assert.doesNotMatch(block, /slice\(0, *\d{2,}/, `${tool} must not cut with slice`);
    assert.doesNotMatch(block, /more lines/, `${tool} must not say "… N more lines"`);
    assert.doesNotMatch(block, /open it from/, `${tool} must not defer content elsewhere`);
  }
});

test("the shared codeBlock helper does not truncate either (#snip)", () => {
  // `codeBlock(text, 1500)` was how write_file's content got cut, so the helper itself must be clean
  const src = readFileSync(ROWS, "utf8");
  const decl = src.slice(src.indexOf("const codeBlock ="), src.indexOf("const argsBlock"));
  assert.ok(decl.includes("<HighlightedCode text={text}"), "it must pass the text through unchanged");
  assert.doesNotMatch(decl, /truncate\(/, "no truncation in the helper");
});
