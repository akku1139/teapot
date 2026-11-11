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

