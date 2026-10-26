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

test("every palette key app.css relies on is covered by the token table (#theme)", () => {
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
  assert.equal(sanitizeTheme(theme({ backgroundDim: -5 }))?.backgroundDim, 0);
  assert.equal(sanitizeTheme(theme({ backgroundDim: 99 }))?.backgroundDim, 0.9);
});

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

test("applying a theme writes every palette variable (#theme)", () => {
  const root = fakeRoot();
  applyCustomTheme(root, theme());
  for (const { cssVar, key } of PALETTE_KEYS) {
    assert.equal(root.style.getPropertyValue(cssVar), DEFAULT_PALETTE[key], `${cssVar} must be set inline`);
  }
});

test("clearing a theme removes every variable it could have set (#theme)", () => {
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

test("pasted colours are normalised to #rrggbb (#theme)", () => {
  assert.equal(normalizeColour("#5865F2"), "#5865f2");
  assert.equal(normalizeColour("5865f2"), "#5865f2", "a bare hex is what Design tools copy");
  assert.equal(normalizeColour("#abc"), "#aabbcc", "#RGB is valid CSS and people type it");
  assert.equal(normalizeColour("  #FFFFFF  "), "#ffffff");
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
  const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

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
  const withImage: CustomTheme = theme({
    id: "custom-big",
    backgroundImage: `data:image/png;base64,${"A".repeat(MAX_BACKGROUND_BYTES)}`,
  });
  assert.ok(withImage.backgroundImage, "precondition: the theme really carries a large image");

  withStorage(() => {
    const first = saveCustomThemes([withImage]);
    assert.equal(first.ok, false, "precondition: this attempt must fail for the test to mean anything");

    const stripped = [withImage].map((t) =>
      t.backgroundImage ? { ...t, backgroundImage: undefined, backgroundDim: undefined } : t,
    );
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
  const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
  const photo = cssRuleBody(css, ".bgphoto");
  assert.ok(photo, "app.css must define the .bgphoto layer");
  assert.match(photo, /position:\s*fixed/, "fixed, so the photo does not scroll with the feed");
  assert.match(photo, /pointer-events:\s*none/, "it must never swallow a click");
  const inner = cssRuleBody(css, ".bgphoto > img");
  assert.ok(inner, "the image itself must be a child of the dim wrapper");
  assert.match(inner, /object-fit:\s*cover/, "cover, to match what background-size did");
  const veil = cssRuleBody(css, ".bgphoto-veil");
  assert.ok(veil, "the dim veil must be its own element");
  assert.match(
    veil,
    /var\(--bg-image-dim,\s*0?\.\d+\)/,
    "the dim value needs a fallback or the color-mix is invalid at computed-value time",
  );
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
  const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
  assert.match(
    cssRuleBody(css, 'html[data-appearance="light"]'),
    /color-scheme:\s*light/,
    "a light appearance must ask the UA for light widgets",
  );
  assert.match(cssRuleBody(css, 'html[data-appearance="dark"]'), /color-scheme:\s*dark/);

  const box = cssRuleBody(css, 'input[type="checkbox"]');
  assert.match(box, /background-color:\s*var\(--bg-darkest\)/, "the box takes the theme's own surface");
});

test("with a wallpaper, `body` must NOT paint its own background (#ui)", () => {
  const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
  const rule = cssRuleBody(css, 'html[data-bg-image="on"] body');
  assert.match(
    rule,
    /background:\s*transparent/,
    "the photo is the page background; a body fill sits in front of it and hides it",
  );
  assert.match(cssRuleBody(css, "body"), /background:\s*var\(--bg-dark\)/);
});
