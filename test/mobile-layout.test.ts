import { test } from "node:test";
import assert from "node:assert/strict";
import { cssRuleBody } from "./helpers/css.ts";
import { readSource } from "./helpers/source.ts";

/**
 * Four phone-width reports, all from the same viewport, all structural:
 *
 *   1. the top bar's right side was cut off;
 *   2. the timeline scrolled SIDEWAYS;
 *   3. maximizing the composer, and the 📎 button, left the input very short.
 *
 * (3) has a second half: the attachment button rendered to the LEFT of the box, so it took width
 * from the input as well as height. Measured before/after in a 500px-wide window: the textarea was
 * beside the four controls; it now spans the row and the controls sit under it, and the maximized
 * box is 725px tall.
 *
 * These are CSS contracts, not pixels: happy-dom does no layout, so the assertions are about the
 * declarations that produce the layout (the same approach `test/helpers/css.ts` exists for).
 */
const css = () => readSource("frontend/app.css");
/** the body of the `@media (max-width: Npx)` block that carries the phone-width declarations */
const phoneBlock = (source: string): string => {
  const at = source.indexOf(`@media (max-width: 620px) {`);
  if (at < 0) return "";
  // brace-match from the opening brace so nested rule bodies are included
  let depth = 0;
  for (let i = source.indexOf("{", at); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (!depth) return source.slice(at, i + 1);
    }
  }
  return "";
};

test("the channel header may shrink and wrap at phone width (#mobile)", () => {
  const head = cssRuleBody(css(), ".chan-head");
  assert.match(head, /flex-wrap:\s*wrap/, "a nowrap header cuts its right side off (#mobile)");
  assert.match(
    head,
    /min-width:\s*0/,
    "a flex container will not go below its min-content width without this (#mobile)",
  );
});

test("the timeline cannot scroll sideways (#mobile)", () => {
  const block = phoneBlock(css());
  assert.ok(block, "a phone-width block must exist");
  assert.match(
    block,
    /\.toolbody[^{]*\{[^}]*overflow-wrap:\s*anywhere/,
    "one unbreakable run in a tool row is what sets the column's min-content width and makes the " +
      "timeline pan — the code surfaces must break, not overflow (#mobile)",
  );
  assert.match(
    block,
    /overflow-x:\s*hidden/,
    "and the feed must not grow to that width (#mobile)",
  );
});

test("the attachment button sits UNDER the textarea, not beside it (#mobile)", () => {
  const block = phoneBlock(css());
  assert.ok(block, "a phone-width block must exist");
  assert.match(
    block,
    /\.composer form > textarea[^{]*\{[^}]*flex:\s*1 1 100%/,
    "on a phone the textarea must take the whole row — beside four controls it lost most of its " +
      "width, which is the complaint that the input became narrow (#mobile)",
  );
});

test("the maximized composer uses the SAME surface as the normal one (#mobile)", () => {
  /**
   * Maximizing used `--surface-alpha + 0.06` while `.composer form` used
   * `--surface-alpha-composer`, so the maximized box was 0.88 against the normal 0.39 — twice as
   * opaque, and the wallpaper stopped showing through ("最大化した入力欄が背景付きテーマで背景透過
   * されてない"). Two formulas for one surface is how they drifted.
   */
  const source = css();
  const maxAt = source.indexOf('html[data-bg-image="on"] .composer.maximized,');
  assert.ok(maxAt > 0, "the maximized wallpaper rule must exist");
  const rule = source.slice(maxAt, source.indexOf("}", maxAt));
  assert.match(
    rule,
    /--surface-alpha-composer/,
    "the maximized box must share the prompt box's alpha — a second formula is what made it " +
      "opaque enough to hide the wallpaper (#mobile)",
  );
  assert.doesNotMatch(
    rule,
    /min\(1, var\(--surface-alpha[^-]/,
    "and must not compute its own panel-strength alpha (#mobile)",
  );
});
