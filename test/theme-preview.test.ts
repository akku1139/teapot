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
import { previewLayers, veilColour, backgroundImageValue } from "../frontend/lib/theme-preview.ts";

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

test("a stored image URL becomes a VALID background-image value (#theme-preview)", () => {
  /**
   * Reported as "テーマカードの背景画像ができてない" with markup showing
   * `<span class="tprev-bg"></span>` — no style at all.
   *
   * `CustomTheme.backgroundImage` holds a BARE URL (`/api/assets/<hex>.png`, a `data:` URI, or an
   * `http(s)://` URL). Assigning that straight to `background-image` is invalid CSS and the browser
   * drops the declaration, so the element renders with no image while the title still says
   * "with a background image". `url()` is what makes it a value.
   */
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
  // a quote in the value cannot break out of the declaration
  assert.ok(
    !/url\(".*".*"\)/.test(backgroundImageValue('a"b')!),
    `an embedded quote must be escaped, got ${String(backgroundImageValue('a"b'))}`,
  );
});

test("the image slot does not STRETCH to its grid row's height (#theme-preview)", async () => {
  /**
   * Reported with markup: "replace imageがちょっと気になる … 上下に帯がでてる".
   *
   * MEASURED in headless Firefox: the button was 108px tall around an 84px image, with the picture
   * offset 12px from the top, so a band of the button's own background showed above and below it
   * inside the border. Removing the `<img>` left the button at 108px — the height was not the
   * image's.
   *
   * Cause: the slot lives in a `.cfggrid` row beside the dim/surfaces controls, whose labels are
   * taller than a thumbnail. A grid item STRETCHES by default, so the button took the row height.
   * `align-self: start` is the fix, and it is a CSS contract rather than a measurement because no
   * browser is available in the suite.
   */
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
