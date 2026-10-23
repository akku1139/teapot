/**
 * A THEME CARD'S PREVIEW SHOWS THE WALLPAPER, WITH THE OPERATOR'S TRANSPARENCY — COUNTED ONCE.
 *
 * Asked for as "テーマカードに背景画像(透過設定付きで)も出すようになると嬉しい / その場合、下側の背景
 * 透過と重複しないようにしないといけない".
 *
 * The second clause is the hard part. The app composes a photo in two stages: a VEIL is painted over
 * the image (`--bg-image-dim`), and then translucent panels are painted over that. A preview that
 * dimmed the photo AND drew the panels at reduced opacity would apply the dim twice and show a
 * surface considerably denser than the app ever does — a preview that lies about every theme.
 *
 * MEASURED in headless Firefox with a WHITE background image (`surfaceAlpha 0.5`, `backgroundDim
 * 0.2`): the tile's unfilled corner sampled `(30, 34, 42)` against the dialog's `(43, 46, 57)`,
 * i.e. lighter than its surroundings — the photo is visible. With the previous flat preview there
 * was nothing to see, and a theme carrying an image previewed identically to one without.
 *
 * These assertions pin the ORDERING and the derived values, because the single-vs-double counting
 * is invisible in a screenshot as long as something is drawn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { previewLayers, veilColour } from "../frontend/theme-preview.ts";

test("the preview derives its panel opacities from the theme's own slider (#theme-preview)", () => {
  const dense = previewLayers(1, 0.9);
  const sheer = previewLayers(0.4, 0.9);
  assert.ok(
    dense.panel > sheer.panel,
    "a denser surface setting must preview denser, or the slider has no visible effect on the card",
  );
  // the app puts the panel one step BELOW the base and the raised surface above it
  const base = previewLayers(0.8, 0.9);
  assert.ok(base.panel < 0.8, "the panel sits below the base alpha, as `--surface-alpha − 0.05` does");
  assert.ok(base.raised > 0.8, "the raised surface sits above it, as `+ 0.06` does");
  assert.ok(
    base.raised > base.panel,
    "ordering must survive: the content surface is denser than the chrome around it",
  );
});

test("defaults match the app's own, so a theme that sets nothing previews correctly (#theme-preview)", () => {
  const d = previewLayers(undefined, undefined);
  // app.css: `--surface-alpha` defaults to 0.82 and the wallpaper dim to 0.9
  assert.ok(Math.abs(d.dim - 0.9) < 1e-9, `dim default must be 0.9, got ${d.dim}`);
  assert.ok(Math.abs(d.panel - 0.77) < 1e-9, `panel default must be 0.77, got ${d.panel}`);
});

test("an out-of-range slider is clamped rather than producing an invisible tile (#theme-preview)", () => {
  for (const n of [-3, 0, 2, Number.NaN]) {
    const l = previewLayers(n, n);
    for (const v of [l.dim, l.panel, l.raised]) {
      assert.ok(Number.isFinite(v), `layer opacity must stay finite, got ${String(v)} for input ${n}`);
      assert.ok(v >= 0 && v <= 1, `layer opacity must stay within [0,1], got ${v} for input ${n}`);
    }
  }
});

test("the veil tints toward the THEME's surface, never toward black (#theme-preview)", () => {
  /**
   * The app's veil is `color-mix(--bg-dark, dim)`. A fixed black overlay was a reported bug in the
   * app itself: a light theme with a photo behind it got a dark wash and the panels looked like
   * they floated on a black page. The preview must not reintroduce it.
   */
  const light = veilColour("#eceef4", 0.9);
  assert.match(light, /#eceef4/, "the veil must mix the theme's own surface colour");
  assert.ok(!/000000|black/i.test(light), "a fixed black veil is the direction bug, not a default");
  assert.match(veilColour("#232630", 0.2), /20%/, "the dim value must reach the mix");
  // an unsupported `color-mix` degrades to the plain surface, which is still readable
  assert.match(veilColour("#232630", 0), /0%/);
});
