import { test } from "node:test";
import assert from "node:assert/strict";
import { previewLayers, veilColour, backgroundImageValue } from "../frontend/lib/theme-preview.ts";

test("the preview derives its panel opacities from the theme's own slider (#theme-preview)", () => {
  const dense = previewLayers(1, 0.9);
  const sheer = previewLayers(0.4, 0.9);
  assert.ok(
    dense.panel > sheer.panel,
    "a denser surface setting must preview denser, or the slider has no visible effect on the card",
  );
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
  const light = veilColour("#eceef4", 0.9);
  assert.match(light, /#eceef4/, "the veil must mix the theme's own surface colour");
  assert.ok(!/000000|black/i.test(light), "a fixed black veil is the direction bug, not a default");
  assert.match(veilColour("#232630", 0.2), /20%/, "the dim value must reach the mix");
  assert.match(veilColour("#232630", 0), /0%/);
});

test("a stored image URL becomes a VALID background-image value (#theme-preview)", () => {
  assert.equal(
    backgroundImageValue("/api/assets/0123456789abcdef0123456789abcdef.png"),
    'url("/api/assets/0123456789abcdef0123456789abcdef.png")',
    "a server-relative asset path must be wrapped",
  );
  assert.equal(
    backgroundImageValue("https://example.test/a b.png"),
    'url("https://example.test/a b.png")',
    "quotes keep a remote URL with spaces intact",
  );
  const data = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(
    backgroundImageValue(data),
    `url("${data}")`,
    "a data URI survives: colours and commas inside the quotes are part of the value",
  );
  assert.equal(backgroundImageValue(undefined), undefined, "no image means no layer");
  assert.equal(backgroundImageValue("   "), undefined, "blank is not an image");
  assert.ok(
    !/url\(".*".*"\)/.test(backgroundImageValue('a"b')!),
    `an embedded quote must be escaped, got ${String(backgroundImageValue('a"b'))}`,
  );
});

test("the image slot does not STRETCH to its grid row's height (#theme-preview)", async () => {
  const css = (await import("./helpers/source.ts")).stripSourceComments(
    (await import("./helpers/source.ts")).readSource("frontend/app.css"),
  );
  const rule = /\.bgpick\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, "the image slot must have its own rule");
  assert.match(
    rule![1]!,
    /align-self:\s*start/,
    "the slot must opt OUT of the grid's default stretch, or it grows to the row height and shows " +
      "a band around the picture (#theme-preview)",
  );
});
