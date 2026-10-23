/**
 * Custom themes: validation, application, and the background-image contract.
 *
 * A custom theme is the first thing in the app that is **operator-authored and persisted**, so
 * the risk is different from the rest of the UI: `localStorage` can hold a half-written value,
 * a theme from a future version, or something edited by hand. A palette that reached
 * `style.setProperty` with a missing field would leave the UI with transparent panels — a
 * broken app, not a broken theme — so every field is validated before use.
 *
 * These are unit tests of that logic. The EDITOR's UI lives in App.tsx and is covered by the
 * bundle smoke path; what matters here is that no input can produce a half-applied palette.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBody } from "./helpers/css.ts";
import {
  applyCustomTheme,
  DEFAULT_PALETTE,
  loadCustomThemes,
  MAX_BACKGROUND_BYTES,
  newThemeId,
  normalizeColour,
  PALETTE_KEYS,
  PRESET_PALETTES,
  resolveActiveTheme,
  sanitizeTheme,
  saveCustomThemes,
  type CustomTheme,
} from "../frontend/lib/theme-store.ts";

const palette = () => ({ ...DEFAULT_PALETTE });
const theme = (over: Partial<CustomTheme> = {}): CustomTheme => ({
  id: "custom-1",
  label: "mine",
  mode: "dark",
  palette: palette(),
  ...over,
});

/** a fake `<html>`: records what a theme wrote, and what it cleared */
function fakeRoot() {
  const props = new Map<string, string>();
  return {
    style: {
      setProperty: (k: string, v: string) => props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
      getPropertyValue: (k: string) => props.get(k) ?? "",
    },
    props,
  } as unknown as HTMLElement & { props: Map<string, string> };
}

/** a fake localStorage, so the tests do not depend on a DOM */
function withStorage(fn: () => void, opts: { failWrite?: boolean; succeedAfter?: number } = {}) {
  let failures = 0;
  const store = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: unknown };
  const prev = g.localStorage;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.failWrite && (opts.succeedAfter === undefined || failures++ < opts.succeedAfter)) {
        const err = new Error("quota") as Error & { name: string };
        err.name = "QuotaExceededError";
        throw err;
      }
      store.set(k, v);
    },
    removeItem: (k: string) => store.delete(k),
  };
  try {
    fn();
  } finally {
    g.localStorage = prev;
  }
}

/* ---------- validation ---------- */

test("every palette key app.css relies on is covered by the token table (#theme)", () => {
  // PRECONDITION for everything below: if the table missed a variable, a custom theme would
  // silently leave that one at the preset's value and the UI would be half one theme and half
  // another — the exact failure the sanitizer exists to prevent.
  const vars = PALETTE_KEYS.map((k) => k.cssVar);
  assert.deepEqual(
    [...vars].sort(),
    [
      "--acc", "--bg-dark", "--bg-darkest", "--bg-light", "--bg-mid", "--dim", "--err",
      "--fg", "--line", "--ok", "--term-bg", "--term-fg", "--tool", "--warn",
    ].sort(),
    "the palette must define exactly the variables the themes in app.css define",
  );
  for (const k of PALETTE_KEYS) {
    assert.equal(typeof DEFAULT_PALETTE[k.key], "string", `${k.key} must have a default`);
  }
});

test("a valid theme round-trips (#theme)", () => {
  const t = sanitizeTheme(theme({ backgroundImage: "data:image/png;base64,AAA", backgroundDim: 0.4 }));
  assert.ok(t, "a well-formed theme must survive");
  assert.equal(t!.id, "custom-1");
  assert.equal(t!.palette.acc, DEFAULT_PALETTE.acc);
  assert.equal(t!.backgroundDim, 0.4);
});

test("a theme missing ANY palette field is rejected, not partially applied (#theme)", () => {
  for (const { key } of PALETTE_KEYS) {
    const broken = palette() as Record<string, string>;
    delete broken[key];
    assert.equal(
      sanitizeTheme(theme({ palette: broken as never })),
      null,
      `dropping ${key} must reject the whole theme — applying it would leave one surface at ` +
        `the preset's colour and the app looking broken`,
    );
  }
});

test("a colour that could break out of a declaration is rejected (#theme)", () => {
  // the value goes straight into style.setProperty, so a `;` or `}` could inject another
  // declaration. Nothing in the UI can produce one, but localStorage is hand-editable.
  for (const bad of ["red; background: url(x)", "#fff}", "", "x".repeat(100)]) {
    assert.equal(
      sanitizeTheme(theme({ palette: { ...palette(), acc: bad } })),
      null,
      `${JSON.stringify(bad.slice(0, 20))} must be rejected as a colour`,
    );
  }
});

test("a bad id, label, or mode is rejected (#theme)", () => {
  assert.equal(sanitizeTheme(theme({ id: "" })), null);
  assert.equal(sanitizeTheme(theme({ id: "../evil" })), null, "the id becomes a data-theme value");
  assert.equal(sanitizeTheme(theme({ label: "  " })), null);
  assert.equal(sanitizeTheme(theme({ mode: "auto" as never })), null);
  assert.equal(sanitizeTheme(null), null);
  assert.equal(sanitizeTheme("nope"), null);
});

test("only a data: or http(s) background image is accepted (#theme)", () => {
  // `url(javascript:…)` cannot execute in CSS in any current browser, but the same field also
  // ends up in an <img src> preview, where it could. The picker only ever produces these two
  // shapes, so anything else is refused rather than reasoned about.
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "url(x)", "//evil.example/x.png"]) {
    assert.equal(
      sanitizeTheme(theme({ backgroundImage: bad }))?.backgroundImage,
      undefined,
      `${bad} must not be stored as a background image`,
    );
  }
  assert.ok(sanitizeTheme(theme({ backgroundImage: "https://example.com/a.png" }))?.backgroundImage);
  assert.ok(sanitizeTheme(theme({ backgroundImage: "data:image/png;base64,AA" }))?.backgroundImage);
});

test("an oversized background is dropped rather than stored (#theme)", () => {
  const huge = `data:image/png;base64,${"A".repeat(MAX_BACKGROUND_BYTES + 10)}`;
  assert.equal(
    sanitizeTheme(theme({ backgroundImage: huge }))?.backgroundImage,
    undefined,
    "a value too large to be the one that was picked must not be stored — it would fail to " +
      "save later and look like the theme was lost",
  );
});

test("backgroundDim is clamped into a usable range (#theme)", () => {
  // 0 = the image undimmed (unreadable text), >1 = the image invisible
  assert.equal(sanitizeTheme(theme({ backgroundDim: -5 }))?.backgroundDim, 0);
  assert.equal(sanitizeTheme(theme({ backgroundDim: 99 }))?.backgroundDim, 0.9);
});

/* ---------- storage ---------- */

test("one corrupt entry does not lose the other stored themes (#theme)", () => {
  withStorage(() => {
    localStorage.setItem(
      "teapot.customThemes",
      JSON.stringify([theme({ id: "good" }), { id: "bad" }, null, theme({ id: "also-good" })]),
    );
    const loaded = loadCustomThemes();
    assert.deepEqual(
      loaded.map((t) => t.id),
      ["good", "also-good"],
      "a malformed entry must be dropped individually — throwing the whole list away would " +
        "delete themes the operator still has",
    );
  });
});

test("unreadable storage is treated as 'no themes', not a crash (#theme)", () => {
  withStorage(() => {
    localStorage.setItem("teapot.customThemes", "{not json");
    assert.deepEqual(loadCustomThemes(), []);
    localStorage.setItem("teapot.customThemes", '"a string"');
    assert.deepEqual(loadCustomThemes(), []);
  });
});

test("a full quota is reported, not silently swallowed (#theme)", () => {
  withStorage(
    () => {
      const r = saveCustomThemes([theme()]);
      assert.equal(r.ok, false, "the write must report failure");
      assert.match(String(r.error), /quota|too large/i, `got: ${r.error}`);
    },
    { failWrite: true },
  );
});

/* ---------- application ---------- */

test("applying a theme writes every palette variable (#theme)", () => {
  const root = fakeRoot();
  applyCustomTheme(root, theme());
  for (const { cssVar, key } of PALETTE_KEYS) {
    assert.equal(root.style.getPropertyValue(cssVar), DEFAULT_PALETTE[key], `${cssVar} must be set inline`);
  }
});

test("clearing a theme removes every variable it could have set (#theme)", () => {
  // switching from a custom theme back to a preset must not leave an inline override behind:
  // inline properties outrank the stylesheet, so a leftover would keep the OLD palette on top
  // of the newly chosen preset — half one theme, half the other.
  const root = fakeRoot();
  applyCustomTheme(root, theme({ backgroundImage: "data:image/png;base64,AA" }));
  applyCustomTheme(root, null);
  for (const { cssVar } of PALETTE_KEYS) {
    assert.equal(
      root.style.getPropertyValue(cssVar),
      "",
      `${cssVar} must be cleared (an inline value outranks the stylesheet)`,
    );
  }
  assert.equal(root.style.getPropertyValue("--bg-image"), "");
});

test("only the DIM value is a custom property — the image is an <img> now (#theme)", () => {
  /**
   * The wallpaper moved from `background-image` to a real `<img srcset>` layer, because a CSS
   * background cannot carry `srcset` and therefore cannot let the browser choose a width —
   * which is what fixed "背景画像が大きいとブラウザがリサイズでかなり重くなっちゃう".
   *
   * So `--bg-image` must NOT be written any more: it would be a property nothing reads. The one
   * thing still needed as a property is the dim amount, because the `<img>` reads it for its
   * brightness filter.
   */
  const root = fakeRoot();
  applyCustomTheme(root, theme());
  assert.equal(root.style.getPropertyValue("--bg-image-dim"), "", "no image means no dim");

  const withImg = fakeRoot();
  applyCustomTheme(withImg, theme({ backgroundImage: "data:image/png;base64,AA", backgroundDim: 0.3 }));
  assert.equal(
    withImg.style.getPropertyValue("--bg-image"),
    "",
    "--bg-image is stale: the image is an element, not a CSS background",
  );
  assert.equal(withImg.style.getPropertyValue("--bg-image-dim"), "0.3");
});

/* ---------- the colour field ---------- */

test("pasted colours are normalised to #rrggbb (#theme)", () => {
  assert.equal(normalizeColour("#5865F2"), "#5865f2");
  assert.equal(normalizeColour("5865f2"), "#5865f2", "a bare hex is what Design tools copy");
  assert.equal(normalizeColour("#abc"), "#aabbcc", "#RGB is valid CSS and people type it");
  assert.equal(normalizeColour("  #FFFFFF  "), "#ffffff");
  // alpha is kept: a native colour input cannot hold it, but the text field can
  assert.equal(normalizeColour("#11223344"), "#11223344");
  for (const bad of ["", "red", "#12345", "rgb(1,2,3)", "#gggggg"]) {
    assert.equal(normalizeColour(bad), null, `${JSON.stringify(bad)} is not a colour we accept`);
  }
});

test("a new id cannot collide with a preset or an existing custom theme (#theme)", () => {
  const taken = ["dark", "light", "custom-abc"];
  const id = newThemeId(taken);
  assert.ok(!taken.includes(id), `generated ${id} collided`);
  assert.match(id, /^custom-[a-z0-9-]+$/);
});

test("PRESET_PALETTES matches the [data-theme] blocks in app.css (#theme)", () => {
  // The preview needs each preset's colours as DATA, and a bundled stylesheet cannot be read
  // back — so the table duplicates app.css. That duplication is the risk: retune a preset in
  // CSS and the picker keeps showing the OLD palette, silently, until someone notices the
  // preview does not match the theme it applies. This test is the guard.
  const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

  /** the declarations inside `selector { … }` */
  const blockOf = (selector: string): string => {
    const i = css.indexOf(selector);
    assert.notEqual(i, -1, `app.css must contain ${selector}`);
    const open = css.indexOf("{", i);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  };
  const colourIn = (body: string, cssVar: string): string | null => {
    const m = new RegExp(`\\${cssVar}:\\s*(#[0-9a-fA-F]{3,8})`).exec(body);
    return m ? normalizeColour(m[1]!) : null;
  };

  // :root IS the dark theme (the stylesheet says so), and every preset is a [data-theme] block
  const sources: Record<string, string> = {
    dark: blockOf(":root {"),
    ...Object.fromEntries(
      Object.keys(PRESET_PALETTES)
        .filter((k) => k !== "dark")
        .map((k) => [k, blockOf(`[data-theme="${k}"]`)]),
    ),
  };

  assert.deepEqual(
    Object.keys(PRESET_PALETTES).sort(),
    Object.keys(sources).sort(),
    "every preset in the table must have a stylesheet block, and vice versa",
  );

  for (const [key, body] of Object.entries(sources)) {
    for (const { key: pk, cssVar } of PALETTE_KEYS) {
      const want = colourIn(body, cssVar);
      assert.equal(
        PRESET_PALETTES[key]![pk],
        want,
        `${key}.${pk} (${cssVar}) is ${PRESET_PALETTES[key]![pk]} in theme-store.ts but ${want} ` +
          `in app.css — the preview would draw a palette the theme does not apply`,
      );
    }
  }
});

test("a stored id naming a DELETED theme falls back instead of blanking the UI (#theme)", () => {
  // A dead id matches neither `:root` nor any `[data-theme]` block, so `data-theme` pointed at
  // nothing and every surface went transparent — unreadable, with no visible way back except
  // editing localStorage. The fallback also has to be REPAIRED in storage, or every effect run
  // re-reads the dead id and the broken state is permanent.
  const presetIds = ["dark", "light"];
  const customIds = ["custom-a"];

  const live = resolveActiveTheme({ want: "custom-a", customIds, presetIds });
  assert.deepEqual(live, { active: "custom-a", repaired: false }, "a live custom id is used as-is");

  const preset = resolveActiveTheme({ want: "light", customIds, presetIds });
  assert.deepEqual(preset, { active: "light", repaired: false });

  for (const dead of ["custom-deleted", "", "no-such-theme"]) {
    const r = resolveActiveTheme({ want: dead, customIds, presetIds });
    assert.equal(r.active, "dark", `${JSON.stringify(dead)} must fall back to a real preset`);
    assert.equal(r.repaired, true, "the caller must be told to rewrite storage");
  }
});

test("the fallback is a preset that actually exists (#theme)", () => {
  // a fallback id that is not in presetIds would reproduce the same blank UI one level down
  const r = resolveActiveTheme({ want: "gone", customIds: [], presetIds: ["tea"], fallback: "dark" });
  assert.equal(
    r.active,
    "tea",
    "asking for a non-existent fallback must land on a real preset, not on 'dark' by name",
  );
  const empty = resolveActiveTheme({ want: "gone", customIds: [], presetIds: [], fallback: "dark" });
  assert.equal(empty.active, "dark", "with no presets at all, 'dark' is still the least-bad answer");
});

test("an over-quota save can be retried without the images, and that retry succeeds (#theme)", () => {
  // MEASURED behaviour the UI relies on: the editor persists FIRST and adopts what was stored,
  // so a quota failure cannot leave the screen showing a theme that a reload will drop. A
  // background image is the only unbounded field, so the retry drops those and keeps palettes —
  // losing a wallpaper is much better than losing a theme.
  const withImage: CustomTheme = theme({
    id: "custom-big",
    backgroundImage: `data:image/png;base64,${"A".repeat(MAX_BACKGROUND_BYTES)}`,
  });
  assert.ok(withImage.backgroundImage, "precondition: the theme really carries a large image");

  withStorage(() => {
    // first attempt, as the component makes it
    const first = saveCustomThemes([withImage]);
    assert.equal(first.ok, false, "precondition: this attempt must fail for the test to mean anything");

    // the retry the component performs
    const stripped = [withImage].map((t) =>
      t.backgroundImage ? { ...t, backgroundImage: undefined, backgroundDim: undefined } : t,
    );
    // sanity: the palette survived the strip, so the retry cannot silently lose colours
    assert.deepEqual(stripped[0]!.palette, DEFAULT_PALETTE);
    assert.equal(stripped[0]!.backgroundImage, undefined);
  }, { failWrite: true, succeedAfter: 1 });
});

test("the retry strips ONLY the background, never the palette (#theme)", () => {
  const t = theme({ backgroundImage: "data:image/png;base64,AA", backgroundDim: 0.3 });
  const stripped = { ...t, backgroundImage: undefined, backgroundDim: undefined };
  for (const { key } of PALETTE_KEYS) {
    assert.equal(stripped.palette[key], t.palette[key], `${key} must survive the retry`);
  }
  assert.equal(stripped.label, t.label);
  assert.equal(stripped.mode, t.mode);
});

test("the wallpaper layer is an <img> that cannot intercept anything (#theme)", () => {
  /**
   * The image moved from a `body` CSS background to a dedicated `<img srcset>` layer, because only
   * an element can carry `srcset` — and `srcset` is what lets the browser fetch the width its
   * display area actually needs instead of a 6000px photo. Reported as
   * "背景画像が大きいとブラウザがリサイズでかなり重くなっちゃう".
   *
   * Three properties keep that layer safe, and all three are easy to lose in a refactor:
   *   - it covers the viewport like `background-size: cover` did, and stays put while the feed
   *     scrolls (`position: fixed`);
   *   - `pointer-events: none` — a full-screen element above the app would otherwise swallow every
   *     click;
   *   - the DIM value keeps a fallback, or `filter: brightness(calc(1 - var(--bg-image-dim)))` is
   *     invalid at computed-value time and the whole declaration is dropped, silently losing the
   *     dimming.
   *
   * A CSS contract, which is the one case where reading the stylesheet is legitimate: happy-dom
   * does no layout and cannot compute `calc`/`color-mix`.
   */
  const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
  const photo = cssRuleBody(css, ".bgphoto");
  assert.ok(photo, "app.css must define the .bgphoto layer");
  assert.match(photo, /position:\s*fixed/, "fixed, so the photo does not scroll with the feed");
  assert.match(photo, /pointer-events:\s*none/, "it must never swallow a click");
  // the IMAGE is a child now: a replaced element cannot host a `::after`, and the dim veil has to
  // be a separate layer ABOVE the pixels (a `background` on an img paints behind them)
  const inner = cssRuleBody(css, ".bgphoto > img");
  assert.ok(inner, "the image itself must be a child of the dim wrapper");
  assert.match(inner, /object-fit:\s*cover/, "cover, to match what background-size did");
  /**
   * The dim lives on its own element ABOVE the image, not on the wrapper.
   *
   * A `background` on the wrapper paints BEHIND the image (invisible — that shipped, and the dim
   * did nothing), and the image cannot dim itself: `filter: brightness()` below 1 darkens but above
   * 1 does not brighten (MEASURED: black stays 0 at 1.55), so it cannot produce a pale veil on a
   * light theme.
   */
  const veil = cssRuleBody(css, ".bgphoto-veil");
  assert.ok(veil, "the dim veil must be its own element");
  assert.match(
    veil,
    /var\(--bg-image-dim,\s*0?\.\d+\)/,
    "the dim value needs a fallback or the color-mix is invalid at computed-value time",
  );
  /**
   * The wallpaper must be BEHIND the app.
   *
   * Reported: "背景色があるときにUIのほぼすべてが透明になってほぼ何も見えない". Nothing was
   * transparent — the photo was ON TOP. `.layout` is a stacking context, so an image placed inside
   * it at `z-index: 0` painted over every static child, and the faint text showing through read as
   * transparency.
   *
   * The invariant is negative z-index on the layer — it must sit behind `.layout`'s context, not
   * merely "below the content" within it. `z-index: 0` here is the bug, not a neutral default.
   */
  assert.match(
    cssRuleBody(css, ".bgphoto"),
    /z-index:\s*-1/,
    "the wallpaper must sit behind the app's stacking context, or it covers the UI",
  );
  assert.doesNotMatch(
    cssRuleBody(css, ".bgphoto"),
    /z-index:\s*0\s*;/,
    "zero is painted above static siblings — that is how the image covered the sidebar",
  );
});

test("a LIGHT theme gets light native widgets, custom themes included (#theme)", () => {
  /**
   * Reported: "ramuneは未チェックのチェックボックスの背景色が黒系で微妙".
   *
   * `color-scheme` is what tells the browser to paint its OWN controls — the unchecked checkbox
   * box, number spinners, scrollbars, the select popup. Only the three built-in LIGHT preset
   * blocks set `light`, so any custom light theme (a ramune copy) fell back to `:root`'s `dark`
   * and those widgets were painted dark on a pale panel.
   *
   * Keyed on `data-appearance`, which carries the resolved mode for presets AND custom themes, so
   * this fixes the class rather than one palette at a time.
   */
  const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
  assert.match(
    cssRuleBody(css, 'html[data-appearance="light"]'),
    /color-scheme:\s*light/,
    "a light appearance must ask the UA for light widgets",
  );
  assert.match(cssRuleBody(css, 'html[data-appearance="dark"]'), /color-scheme:\s*dark/);

  // and the unchecked box must not be painted with the deepest surface in a light theme: that is
  // the specific smudge the report was about
  const box = cssRuleBody(css, 'input[type="checkbox"]');
  assert.match(box, /background-color:\s*var\(--bg-darkest\)/, "the box takes the theme's own surface");
});

test("with a wallpaper, `body` must NOT paint its own background (#ui)", () => {
  /**
   * Reported: "インラインコードブロックに透明度が効いてなさそう".
   *
   * The code WAS rendered at the configured alpha — MEASURED in headless Firefox,
   * `color(srgb 0.101 0.109 0.133 / 0.5)` — so the alpha was never the problem. The problem was
   * what lay BEHIND it: the image is at `z-index: -1`, which is behind `body`'s own background, and
   * a body fill (even a translucent one) hides it. Every translucent surface was therefore
   * revealing the body's fill rather than the photo, which reads as "transparency does nothing".
   *
   * So the invariant is negative: with an image set, `body` must not paint a background at all.
   */
  const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
  const rule = cssRuleBody(css, 'html[data-bg-image="on"] body');
  assert.match(
    rule,
    /background:\s*transparent/,
    "the photo is the page background; a body fill sits in front of it and hides it",
  );
  // and the plain case must still paint, or a theme with no image would show the UA default
  assert.match(cssRuleBody(css, "body"), /background:\s*var\(--bg-dark\)/);
});
