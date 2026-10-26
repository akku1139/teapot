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

test("the wrapper's surface is translucent and derived from the theme (#shiki)", () => {
  const body = rule(".shikiwrap");
  assert.ok(body, ".shikiwrap must exist — every shiki surface uses it");
  assert.match(body, /background:\s*color-mix\(/, "the surface must be a mix, not a solid token");
  assert.match(body, /transparent/, "and it must mix toward transparent, or it is opaque again");
  assert.match(body, /var\(--bg-mid\)/, "mixed against the modal surface, so it is a layer of the SAME material");
});

test("shiki's own background can never win (#shiki)", () => {
  // dual-theme mode sets `--shiki-light-bg: #fff` inline, so every dark theme showed a white block
  const body = rule(".shikiwrap .shiki") + rule(".shikiwrap pre.shiki") + rule(".shikiwrap code.shiki");
  assert.match(body, /background-color:\s*transparent/, "shiki's inline background must be overridden");
  assert.match(body, /!important/, "an inline style needs the rule to win explicitly");
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
