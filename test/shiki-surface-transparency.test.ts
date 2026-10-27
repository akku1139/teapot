import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripSourceComments } from "./helpers/source.ts";

/**
 * A shiki surface is a LAYER, never an opaque hole.
 *
 * Reported twice: "ファイルプレビューで背景透過されてない" and then "極めて透明感が低すぎるし、テーマの
 * 色に従ってない". MEASURED in real Firefox:
 *
 *   - `.filepreview` painted `var(--bg-darkest)` = `rgb(26,28,34)` OPAQUE, inside a modal that was
 *     `rgb(43,46,57)` — darker than its own container, so it read as a hole rather than a layer;
 *   - the alpha only existed under `html[data-bg-image="on"]`, so with no wallpaper the surface was
 *     a plain hex and every transparency rule was inert.
 *   - `.mdpreview` (the markdown preview and the todo pane) still had the same opaque fill.
 *
 * The fix is one wrapper class used by every shiki surface, so a new one is correct by construction
 * rather than by remembering three selector lists.
 */
const css = stripSourceComments(readFileSync("frontend/app.css", "utf8"));

/** every declaration block whose selector list contains `sel` */
const rule = (sel: string): string =>
  [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => m[1]!.split(",").map((x) => x.trim()).includes(sel))
    .map((m) => m[2]!)
    .join("\n");

test("the wrapper paints NO surface of its own (#shiki)", () => {
  /**
   * The container already paints the right surface, and the operator's observation is the test: a
   * file WITHOUT shiki looks right because it inherits the modal's own
   * `color-mix(--bg-mid-solid … transparent)` + `backdrop-filter`. Giving the wrapper its own
   * background made the shiki case a DIFFERENT colour from the plain case in the same dialog, and
   * its `border-radius` clipped the first and last characters.
   *
   * So the wrapper's job is only the two things shiki needs: kill shiki's inline background, and make
   * `<pre>/<code>` wrap. Any surface it inherits is the correct one by construction.
   */
  const body = rule(".shikiwrap");
  assert.ok(body !== undefined, ".shikiwrap must exist — every shiki surface uses it");
  assert.doesNotMatch(body, /background\s*:/, "no surface of its own — the container's must show through");
  assert.doesNotMatch(body, /border-radius/, "and no radius: it clipped the edge characters");
});

test("shiki is configured to emit NO background, so no override is needed (#shiki)", () => {
  /**
   * The old rule here was `.shikiwrap .shiki { background-color: transparent !important }`, whose
   * stated reason was that dual-theme mode sets `--shiki-light-bg: #fff` inline and a dark theme showed
   * a white block.
   *
   * MEASURED: with `defaultColor: false` and dual `themes`, `codeToHast` emits only the CSS variables
   * `--shiki-light-bg` / `--shiki-dark-bg` and NO `background-color` at all. So the `!important` was
   * undoing something the highlighter never did — and it silently beat the container's own surface,
   * which is how a message code block lost its background ("shikiが効いてるコードブロックの背景色がない").
   *
   * This asserts the actual contract: nothing forces shiki's background, because it has none.
   */
  const css = readFileSync("frontend/app.css", "utf8");
  assert.equal(
    /\.shikiwrap\s+\.shiki[^{]*\{[^}]*background-color:\s*transparent/.test(css),
    false,
    "no rule may fight shiki's background any more",
  );
});

test("the markdown preview is not opaque either (#shiki)", () => {
  const body = rule(".mdpreview");
  assert.ok(body, ".mdpreview must have its own rule");
  assert.doesNotMatch(body, /background:\s*var\(--bg-darkest\)/, "a solid token here is the reported hole");
});

test("every shiki surface carries the wrapper (#shiki)", () => {
  /**
   * The class has to be ON the element, or the rules are dead. Read the two components that render
   * one — this is the half a CSS-only test cannot see, and it is what let `.mdpreview` keep its
   * opaque fill through the previous fix.
   */
  const files = stripSourceComments(readFileSync("frontend/components/settings-parts.tsx", "utf8"))
    + stripSourceComments(readFileSync("frontend/components/FilesPanel.tsx", "utf8"));
  assert.match(files, /class="filepreview shikiwrap"/, "the code preview must use the wrapper");
  assert.match(files, /class="content mdpreview shikiwrap"/, "and so must the markdown preview");
});
