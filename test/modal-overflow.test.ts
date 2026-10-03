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
const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

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

test("the new-agent provider column is shrinkable (#36)", () => {
  const label = /<label style="([^"]*)">provider/.exec(app);
  assert.ok(label, "provider label not found in NewAgentModal");
  const style = label[1]!;
  assert.match(style, /min-width:\s*0/, "the provider column must be allowed to shrink");
  assert.match(style, /flex:\s*0 1 auto|flex:1|flex:/, `provider column needs a flex basis: ${style}`);
});

test("no in-modal control is left at min-width:auto", () => {
  // .modal input / select / textarea all share one rule; make sure a later,
  // narrower rule cannot undo it for selects specifically
  assert.doesNotMatch(
    css,
    /\.modal\s+select\s*\{[^}]*min-width:\s*auto/,
    "a later .modal select rule would re-break the shrink",
  );
});

test("the agent-name and model columns keep sharing the row evenly", () => {
  // both neighbours are flex:1; the provider column must not claim all the space
  const name = /<label style="flex:1">agent name/.test(app);
  const model = /<label style="flex:1">model/.test(app);
  assert.ok(name && model, "name/model columns should stay flex:1 around the provider");
});