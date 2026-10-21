/**
 * The 🧦 model box's apply button must not resize when its label changes.
 *
 * Reported: "model パネルの apply を押すと applied でチェックマークの絵文字が出るせいか、ボタンの
 * 高さがちょっと変わってレイアウトシフトする".
 *
 * The label swaps `apply` → `✓ applied` after a successful POST, then back after 1200ms. Two
 * separate things move a box when that happens:
 *
 *   - the STRING is wider, and the button is `flex: 1` in a flex row, so the row re-flows and
 *     the fields above it shift;
 *   - an emoji glyph reports a TALLER line box than the same text without one, so even at the
 *     same width the height changes.
 *
 * This is a CSS contract, which is the one case where reading the stylesheet is legitimate:
 * happy-dom does no layout, so a computed-height assertion is impossible. The declarations
 * that make the box stable are therefore pinned directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cssRuleBody } from "./helpers/css.ts";
import { readSource } from "./helpers/source.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = readSource(path.join(here, "..", "frontend", "app.css"));

test("the model apply button has a fixed height, so an emoji label cannot resize it (#layout)", () => {
  const body = cssRuleBody(css, ".modelbox button");
  assert.ok(body, "the .modelbox button rule must exist");

  // a fixed height is the only way to stop an emoji's taller line box from changing it
  assert.match(
    body,
    /height:\s*\d+px/,
    "the button needs an explicit `height`. Without one, `padding` + line box decide the " +
      "height, and an emoji glyph reports a taller line box than plain text — that is the " +
      "reported shift when the label becomes `✓ applied`.",
  );
  // and the width must be reserved for the LONGEST label, or the flex row re-flows
  assert.match(
    body,
    /min-width:\s*[\d.]+em/,
    "the button needs a `min-width` sized for the longest label, or `flex: 1` re-measures " +
      "the row and moves the fields above it when the text becomes `✓ applied`",
  );
  // centring must not depend on the label's own metrics
  assert.match(body, /display:\s*inline-flex/, "the label must be centred by flex, not by line box");
  assert.match(body, /align-items:\s*center/);
  assert.match(body, /justify-content:\s*center/);
  // box-sizing so `height` is the BORDER box, not the content box plus padding
  assert.match(
    body,
    /box-sizing:\s*border-box/,
    "without border-box the declared `height` excludes padding, so the real height still " +
      "depends on the label",
  );
});
