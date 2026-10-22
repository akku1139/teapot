/**
 * Theme background images live on the SERVER now.
 *
 * They used to be data URIs in `localStorage`, which forced a 1.5MB cap because the whole origin
 * shares a ~5MB quota — one wallpaper could break every other setting the UI keeps there, and a
 * phone photo exceeds 1.5MB anyway. The bytes are files under `<dataDir>/assets/` and the theme
 * holds a short URL, so the limit is gone.
 *
 * These tests pin the three things that make that safe: the name grammar cannot escape the assets
 * directory, an upload round-trips, and a stored reference is only accepted if it points at
 * something this server actually serves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { buildApp } from "../src/server/api.ts";
import { Master } from "../src/master.ts";
import { sanitizeTheme, DEFAULT_PALETTE, applyCustomTheme } from "../frontend/theme-store.ts";
import { readSource, stripSourceComments } from "./helpers/source.ts";
import { cssRuleBody } from "./helpers/css.ts";

const mkMaster = (dataDir: string) =>
  new Master(
    { port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, providers: {}, agents: [] } as never,
    "/dev/null",
  );

/** a minimal valid theme, for the sanitizer tests */
const base = { id: "custom-1", label: "t", mode: "dark" as const, palette: { ...DEFAULT_PALETTE } };

/** a 1x1 PNG */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("an uploaded image is stored on disk and served back (#assets)", async () => {
  const dataDir = mkdtempInRootSync("assets-");
  const app = buildApp(mkMaster(dataDir));

  const up = await app.request("/api/assets", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: PNG,
  });
  assert.equal(up.status, 200);
  const { name, url, bytes } = (await up.json()) as { name: string; url: string; bytes: number };
  assert.match(name, /^[a-f0-9]{32}\.png$/, "the stored name must be the grammar the GET accepts");
  assert.equal(bytes, PNG.length);

  // …and it comes back byte-identical
  const got = await app.request(url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.match(got.headers.get("cache-control") ?? "", /immutable/, "the name is never reused");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
});

test("an asset name that is not the exact grammar is refused (#assets)", async () => {
  /**
   * HONEST SCOPE. Routing already normalises `../` away before the handler runs (MEASURED:
   * `/api/assets/../package.json` is a 404 with or without the name check), so this is NOT the
   * traversal test it looks like. What it does pin is the grammar: only the names this server
   * mints can be read back, so a request cannot name a file that happens to sit in the same
   * directory, and the delete route cannot be pointed at one either.
   */
  const dataDir = mkdtempInRootSync("assets2-");
  const app = buildApp(mkMaster(dataDir));

  // something real, in the assets dir, that the grammar must still refuse
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const path = await import("node:path");
  mkdirSync(path.join(dataDir, "assets"), { recursive: true });
  writeFileSync(path.join(dataDir, "assets", "notes.txt"), "secret");

  for (const bad of ["notes.txt", "abc.png", "a".repeat(32) + ".txt", "short.png"]) {
    const r = await app.request(`/api/assets/${bad}`);
    assert.equal(r.status, 404, `${bad} must not be served — it is not a name this server mints`);
  }
  // and the same names must not be deletable
  for (const bad of ["notes.txt", "a".repeat(32) + ".txt"]) {
    const r = await app.request(`/api/assets/${bad}`, { method: "DELETE" });
    assert.equal(r.status, 404, `${bad} must not be deletable`);
  }
});

test("an upload with a non-image type is refused (#assets)", async () => {
  const dataDir = mkdtempInRootSync("assets3-");
  const app = buildApp(mkMaster(dataDir));
  const r = await app.request("/api/assets", {
    method: "POST",
    headers: { "content-type": "text/html" },
    body: Buffer.from("<script>alert(1)</script>"),
  });
  assert.equal(r.status, 415, "an HTML body must not become a stored asset");
});

test("a stored background reference must point at something this server serves (#assets)", async () => {
  const base = { id: "custom-1", label: "t", mode: "dark" as const, palette: { ...DEFAULT_PALETTE } };
  // the three accepted shapes
  for (const ok of [
    "/api/assets/" + "a".repeat(32) + ".png",
    "data:image/png;base64,AAAA",
    "https://example.com/bg.jpg",
  ]) {
    const t = sanitizeTheme({ ...base, backgroundImage: ok });
    assert.equal(t?.backgroundImage, ok, `${ok} must be accepted`);
  }
  // …and nothing else, because the value becomes `url("…")` in the stylesheet
  for (const bad of [
    "javascript:alert(1)",
    "/api/assets/../../config.json",
    "url(javascript:alert(1))",
    "/api/../secret.png",
  ]) {
    const t = sanitizeTheme({ ...base, backgroundImage: bad });
    assert.equal(t?.backgroundImage, undefined, `${bad} must be dropped`);
  }
});

test("code and tool output get an OPAQUE surface when a background image is set (#ui)", async () => {
  /**
   * Reported: "背景画像入れてるときにコードブロックとかtoolログとかが透明度0で表示されてる".
   *
   * A palette value can carry alpha — `normalizeColour` accepts 8-digit hex — so a theme whose
   * `surface (deepest)` was saved as `#1a1c2200` renders `.embed` and `pre` fully transparent and
   * the photo shows through the code. `applyCustomTheme` now also writes `--bg-darkest-solid`
   * with the alpha stripped, and the stylesheet uses it for machine output when an image is set.
   */
  const { opaque } = await import("../frontend/theme-store.ts");
  assert.equal(opaque("#1a1c2200"), "#1a1c22", "alpha must be stripped");
  assert.equal(opaque("#1A1C22"), "#1A1C22", "an opaque colour is unchanged");
  assert.equal(opaque("rgb(0 0 0 / 0%)"), "rgb(0 0 0 / 0%)", "non-hex is left alone");

  /**
   * The CSS half changed shape when transparency moved to the palette level: `.embed` no longer
   * names a colour at all, it inherits the remapped `--bg-darkest`. What must still hold is that
   * the alpha-stripped value is what the remap MIXES AGAINST — otherwise a translucent palette
   * value is mixed against itself and the result is invisible.
   */
  const css = await (await import("./helpers/source.ts")).readSource("frontend/app.css");
  const { cssRuleBody } = await import("./helpers/css.ts");
  const remap = cssRuleBody(css, 'html[data-bg-image="on"]');
  for (const level of ["darkest", "dark", "mid", "light"]) {
    assert.match(
      remap,
      new RegExp(`--bg-${level}:[^;]*--bg-${level}-solid`),
      `--bg-${level} must mix against its ALPHA-STRIPPED value; mixing a translucent palette ` +
        "colour against itself renders machine output invisible",
    );
  }
  // the machine-output selectors still exist, but only to kill any palette texture — the fill
  // itself now comes from the remapped level above
  assert.match(
    cssRuleBody(css, 'html[data-bg-image="on"] .embed'),
    /background-image:\s*none/,
    "and must not paint a gradient over it",
  );
});

test("the auth choice is derived from the saved headers, not reset (#mcpui)", async () => {
  /**
   * The form now offers none / bearer / custom header / headers-as-JSON instead of a single JSON
   * textarea ("正直わかりやすいとは言い難い"). The derivation has to be reversible: re-opening
   * settings must show the control that matches what is SAVED, or the server silently loses its
   * auth the moment the operator touches anything else on the row.
   *
   * The rule, mirrored from the component: one `Authorization: Bearer …` header is the bearer
   * case; one other header is the custom case; anything else falls back to JSON.
   */
  const derive = (h: Record<string, string> | undefined) => {
    const keys = Object.keys(h ?? {});
    if (!keys.length) return "none";
    const only = keys.length === 1 ? keys[0]! : "";
    if (only === "Authorization" && /^Bearer /i.test(h![only] ?? "")) return "bearer";
    return keys.length === 1 ? "header" : "json";
  };
  assert.equal(derive(undefined), "none");
  assert.equal(derive({}), "none");
  assert.equal(derive({ Authorization: "Bearer sk-123" }), "bearer");
  assert.equal(derive({ Authorization: "bearer lower" }), "bearer");
  assert.equal(derive({ "X-Api-Key": "abc" }), "header");
  assert.equal(derive({ Authorization: "Basic abc" }), "header", "not a bearer token");
  assert.equal(derive({ A: "1", B: "2" }), "json", "more than one header needs the JSON form");

  // and the value must be the token WITHOUT the prefix, or every edit re-prepends it
  const value = (h: Record<string, string>) =>
    Object.keys(h).length === 1 ? (h.Authorization ?? "").replace(/^Bearer /i, "") : "";
  assert.equal(value({ Authorization: "Bearer sk-123" }), "sk-123");
});

test("surfaceAlpha is CLAMPED to a readable floor (#ui)", async () => {
  /**
   * Code blocks and tool cards previously forced a fully opaque fill. Fully opaque fixed a real
   * bug (a palette colour saved with alpha made machine output invisible over a photo) but it is
   * the wrong ceiling — asked for as "コードブロックやtool cardとかが背景画像のために半透明になって
   * ほしい (テーマエディタで透明度も設定できるように?)".
   *
   * The floor matters: at 0 the invisible-output bug comes straight back, so a stored value is
   * clamped rather than trusted. That is the whole point of sanitising on the way in.
   */
  for (const [input, want] of [
    [0, 0.35],
    [-4, 0.35],
    [0.2, 0.35],
    [0.6, 0.6],
    [1, 1],
    [9, 1],
  ] as const) {
    const t = sanitizeTheme({ ...base, surfaceAlpha: input });
    assert.ok(t, `surfaceAlpha=${input} must not make the theme invalid`);
    assert.equal(t.surfaceAlpha, want, `surfaceAlpha=${input} should clamp to ${want}`);
  }
});

test("a theme without surfaceAlpha stays valid and unset (#ui)", async () => {
  // themes saved before this setting existed must keep working, and must NOT be given a value
  // the editor would then show as if the operator had chosen it
  const t = sanitizeTheme({ ...base, backgroundImage: "/api/assets/" + "a".repeat(32) + ".png" });
  assert.ok(t);
  assert.equal(t.surfaceAlpha, undefined);
});

test("every surface level has an alpha-stripped variant when an image is set (#ui)", async () => {
  /**
   * The first implementation named only `--bg-darkest-solid`, and the stylesheet named only SOME
   * selectors. Both were lists of things to forget: a code block inside an EXPANDED TOOL CARD uses
   * a different selector from a markdown code block, and a surface painting from `--bg-mid` had no
   * solid variant to mix against.
   *
   * Reported twice — "コードブロックやtool cardとかが背景画像のために半透明になってほしい", then
   * "ツールカードを展開したときに出るコードブロックも透明感が欲しい / UI全体で透明を意識".
   *
   * So this pins the STRUCTURE: all four levels get a stripped variant, and they go away again
   * when the image does (a leftover inline property would keep overriding the plain palette).
   */
  const writes: Record<string, string> = {};
  const root = {
    style: {
      setProperty: (k: string, v: string) => { writes[k] = v; },
      getPropertyValue: (k: string) => writes[k] ?? "",
      removeProperty: (k: string) => { delete writes[k]; },
    },
    dataset: {} as Record<string, string>,
  } as unknown as HTMLElement;

  const palette = { ...DEFAULT_PALETTE, bgDarkest: "#111111cc", bgDark: "#222222cc", bgMid: "#333333cc", bgLight: "#444444cc" };
  applyCustomTheme(root, { ...base, palette, backgroundImage: "/api/assets/" + "a".repeat(32) + ".png" } as never);

  for (const [name, want] of [
    ["--bg-darkest-solid", "#111111"],
    ["--bg-dark-solid", "#222222"],
    ["--bg-mid-solid", "#333333"],
    ["--bg-light-solid", "#444444"],
  ] as const) {
    assert.equal(writes[name], want, `${name} must be the alpha-stripped base for color-mix()`);
  }

  // clearing the image must clear EVERY variant, or the next plain theme keeps mixing against them
  applyCustomTheme(root, null);
  for (const name of ["--bg-darkest-solid", "--bg-dark-solid", "--bg-mid-solid", "--bg-light-solid"]) {
    assert.equal(writes[name], undefined, `${name} must be removed with the image`);
  }
});

test("a code block paints ONE surface, not a pre and a code stacked (#ui)", async () => {
  /**
   * With a background image the surface colour comes from custom properties, so EVERY element
   * that sets it paints a translucent layer. A `code` inside a `pre` did exactly that, and two
   * layers of the same translucent colour render darker with a visible inner edge — reported as
   * "code側がpreと背景色が違って枠が二重になってる".
   *
   * The trap is specificity: `html[data-bg-image="on"] .content code` (0,1,2,1) beats the base
   * `.content pre code` (0,0,2,1), so the plain "inner code has no background" rule stopped
   * applying exactly when an image was set. This pins the override that restores it.
   */
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const inner = cssRuleBody(css, 'html[data-bg-image="on"] .content pre code');
  assert.match(
    inner,
    /background:\s*none/,
    "the code inside a pre must not paint its own surface, or the block shows a double frame",
  );
  // and the pre must still paint one, or the block loses its surface entirely
  assert.match(cssRuleBody(css, ".content pre"), /background:/);
});
