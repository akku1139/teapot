import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * A tool row's label must SHRINK on a narrow window, not force the timeline wider.
 *
 * Reported as "横幅が短いときに…タイムラインが画面横幅よりも長くて横スクロールが発生してる".
 * MEASURED at a 520px viewport: `.msg` was 520 wide but its CONTENT overflowed to **1091px** —
 * `.feed.scrollWidth` 1091 against `clientWidth` 520 — because `<b>$ <command></b>` is a flex item
 * with no `min-width: 0`, so it refused to go below its content and every row was clipped instead.
 *
 * After the fix: `feed.scrollWidth` == `feed.clientWidth` == 520.
 *
 * This is a CSS contract, the one kind of source read the repo allows: happy-dom does no layout, so a
 * DOM test cannot observe "this flex item failed to shrink" — the rendering engine has to, and the
 * contract has to be stated somewhere.
 */
const CSS = readFileSync(path.join(import.meta.dirname, "..", "frontend", "app.css"), "utf8");

test("the tool label may shrink, with an ellipsis instead of pushing the row (#ui)", () => {
  const block = CSS.slice(CSS.indexOf(".embed summary > b,"), CSS.indexOf(".embed summary > b,") + 400);
  assert.ok(block.length > 40, "precondition: the rule exists");
  assert.match(block, /min-width:\s*0/, "without this a flex item cannot shrink below its content");
  assert.match(block, /overflow:\s*hidden/);
  assert.match(block, /text-overflow:\s*ellipsis/, "and the cut is signalled, not silent");
  assert.match(block, /white-space:\s*nowrap/, "it stays one line, it just gets shorter");
});

test("the copy buttons keep their size — only the text shrinks (#ui)", () => {
  // the shrinking must land on the label, or the ⧉ buttons would collapse instead
  assert.match(CSS, /\.toolcopy\s*\{[^}]*flex-shrink:\s*0/, "the buttons must not be the thing that gives");
});

test("the message body itself can shrink (#ui)", () => {
  // the parent of the tool row; without min-width:0 the same refusal happens one level up
  assert.match(CSS, /\.msg-body\s*\{[^}]*min-width:\s*0/, "a flex child needs min-width:0 to shrink");
});
