/**
 * A tool header's one-line-ness is a CSS contract, not a character count (#275).
 *
 * "bashとかのツールのヘッダーはCSSのoverflowとかで実装すべき / そうでないと画面幅によっては折り返しになる場合がある". Two failures on
 * the same slider: `oneLine(cmd, 96)` cut by CHARACTERS, so whether a command looked whole depended on its length instead
 * of the box — and at a narrow width the label wrapped to two lines rather than ellipsising, because `text-overflow` only
 * applies to a single line and nothing set `white-space: nowrap`.
 *
 * A stylesheet is the one legitimate source read (happy-dom does no layout), so this pins the properties that make the
 * contract hold.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { oneLineFull } from "../frontend/lib/timeline-row.ts";
import { cssRuleBody } from "./helpers/css.ts";
import { readSourceUrl } from "./helpers/source.ts";

const css = readSourceUrl(new URL("../frontend/app.css", import.meta.url));

/** the declarations of the rule whose selector list has `selector` as one entry */
const ruleBody = (selector: string): string => cssRuleBody(css, selector.replace(/,$/, ""));

test("the tool label clips with CSS rather than wrapping", () => {
  const body = ruleBody(".embed summary > b,");
  assert.match(body, /white-space:\s*nowrap/, "text-overflow needs one line to act on");
  assert.match(body, /text-overflow:\s*ellipsis/);
  assert.match(body, /overflow:\s*hidden/);
  assert.match(body, /min-width:\s*0/, "a flex item refuses to shrink without this");
});

test("the label is flattened but not length-capped", () => {
  const long = "x".repeat(500);
  assert.equal(oneLineFull(`  ${long}\n\n more  `), `${long} more`, "newlines collapse to one line");
  assert.ok(oneLineFull(long).length === 500, "no character cap — the box decides where the cut is");
});
