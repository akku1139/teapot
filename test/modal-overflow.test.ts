/**
 * #36 — "in the new-agent dialog the model overflows its parent and the popup
 * ends up horizontally scrollable, which looks bad"
 *
 * A flex item defaults to `min-width: auto`, i.e. its min-content width. A
 * native `<select>` sizes to its LONGEST <option>, not its current value, so a
 * long provider name refused to shrink and pushed the row past .modal's
 * `width: min(620px, 92vw)`. Because .modal sets `overflow-y: auto`, the
 * horizontal overflow value computes to `auto` too — hence the scrollbar.
 *
 * happy-dom does no layout, so this asserts the two CSS invariants that
 * actually govern the behaviour (both mirrors of what .modelbox already does).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBody } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

/**
 * #75: this located a rule by `indexOf(token)` — the first textual mention — and
 * returned the RAW body, so a declaration quoted in a comment could satisfy an
 * assertion on it. Now the shared helper: comments stripped, selector matched
 * exactly (or as one entry of a selector list).
 */
function ruleBody(token: string): string {
  return cssRuleBody(css, token);
}

test("modal controls may shrink below their content width (#36)", () => {
  const body = ruleBody(".modal select");
  assert.match(
    body,
    /min-width:\s*0/,
    "a <select> sized to its longest option overflows the dialog without min-width:0",
  );
});

test("the modelbox rule the fix mirrors really does set min-width:0", () => {
  // guards the comment above it from drifting away from the rule it cites
  assert.match(ruleBody(".modelbox select"), /min-width:\s*0/);
});
