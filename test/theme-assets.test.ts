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
import { sanitizeTheme, DEFAULT_PALETTE, applyCustomTheme } from "../frontend/lib/theme-store.ts";
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
  const { opaque } = await import("../frontend/lib/theme-store.ts");
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

test("with a wallpaper, the surface variables are left to the STYLESHEET (#ui)", async () => {
  /**
   * Reported: "インラインコードブロック、tool、goal、プロンプト欄など (surfaces)の透明設定が効いて
   * ない" — every translucent surface at once, which pointed at the four shared tokens.
   *
   * Cause: `applyCustomTheme` wrote `--bg-darkest`/`--bg-dark`/`--bg-mid`/`--bg-light` INLINE on
   * `<html>`. Inline styles beat the stylesheet's `html[data-bg-image="on"]` remap, so the
   * `color-mix()` values never applied. MEASURED in headless Firefox: a surface with the inline
   * value computed to opaque `rgb(26,28,34)`, the same variable without it to
   * `color(srgb 0.101 0.109 0.133 / 0.5)`.
   *
   * So with an image the four names must be ABSENT inline (the stylesheet owns the translucency)
   * while the `-solid` bases and the alpha are written. Without an image the palette must still be
   * written inline, or a custom theme could not override a preset at all.
   */
  const make = () => {
    const writes: Record<string, string> = {};
    const root = {
      style: {
        setProperty: (k: string, v: string) => { writes[k] = v; },
        getPropertyValue: (k: string) => writes[k] ?? "",
        removeProperty: (k: string) => { delete writes[k]; },
      },
      dataset: {} as Record<string, string>,
    } as unknown as HTMLElement;
    return { writes, root };
  };

  const withImg = make();
  applyCustomTheme(withImg.root, {
    ...base,
    palette: { ...DEFAULT_PALETTE, bgDarkest: "#1a1c22", bgDark: "#232630", bgMid: "#2b2e39", bgLight: "#343845" },
    backgroundImage: `/api/assets/${"a".repeat(32)}.png`,
    surfaceAlpha: 0.5,
  } as never);

  for (const v of ["--bg-darkest", "--bg-dark", "--bg-mid", "--bg-light"]) {
    assert.equal(
      withImg.writes[v],
      undefined,
      `${v} must NOT be inline — it would outrank the stylesheet's translucent remap`,
    );
    assert.ok(withImg.writes[`${v}-solid`], `${v}-solid must be written: the remap mixes against it`);
  }
  assert.equal(withImg.writes["--surface-alpha"], "0.5");

  // no wallpaper → the palette IS written inline (that is how a custom theme wins over a preset)
  const noImg = make();
  applyCustomTheme(noImg.root, { ...base, palette: { ...DEFAULT_PALETTE, bgDarkest: "#1a1c22" } } as never);
  assert.equal(noImg.writes["--bg-darkest"], "#1a1c22");
});

test("the transparency scale is LAYERED, not one alpha for every surface (#ui)", async () => {
  /**
   * Reported as three separate complaints that all had one cause: a single `--surface-alpha` for
   * all four surface levels meant the settings dialog, the side panels and an inline code chip were
   * equally see-through.
   *
   *   "設定パネル等の背景透過が強すぎた"            → the dialog needs to be denser
   *   "インラインコードブロックやツール等は左右パネルより透明にしてほしい" → chips need to be lighter
   *   "左右パネル(上含む)はあと5%くらい透明になってほしい"        → panels nudge down
   *
   * The ordering is the contract: dark < dark-est? No — the rule is that a RAISED surface is
   * denser than the panel it sits on, and a chip inside body text is lighter than both.
   */
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const scale = cssRuleBody(css, 'html[data-bg-image="on"]');
  // four DISTINCT alphas derived from the base, not four uses of one variable
  for (const level of ["darkest", "dark", "mid", "light"]) {
    assert.match(
      scale,
      new RegExp(`--surface-alpha-${level}:`),
      `--surface-alpha-${level} must exist, or every level gets the same transparency`,
    );
  }
  assert.match(scale, /--surface-alpha-dark:\s*var\(--surface-alpha/, "the panel level IS the base");
  assert.match(scale, /calc\(var\(--surface-alpha[^)]*\)\s*-\s*0?\.\d+\)/, "chips must be LIGHTER than the base");
  assert.match(scale, /calc\(var\(--surface-alpha[^)]*\)\s*\+\s*0?\.\d+\)/, "raised surfaces must be DENSER");
  // the base alpha still has a fallback, or the whole remap is invalid at computed-value time
  assert.match(scale, /var\(--surface-alpha,\s*0?\.\d+\)/);
});

test("the appearance section's image block is NOT forced fully opaque (#ui)", async () => {
  /**
   * "appearanceのbackground imageのとこが背景透過されてない". The block forced
   * `--bg-darkest-solid` — fully opaque — because it once held only the wallpaper preview. It now
   * also holds the upload button and two sliders, so it sat as a solid slab inside a translucent
   * dialog.
   */
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const block = cssRuleBody(css, 'html[data-bg-image="on"] .bgpreview');
  assert.doesNotMatch(
    block,
    /background-color:\s*var\(--bg-darkest-solid/,
    "the whole row must not be opaque — only the preview image needs to be",
  );
  assert.match(block, /var\(--bg-mid\)/, "it should use a normal raised surface");
});

test("a skill body renders MARKDOWN and cannot scroll sideways (#ui)", async () => {
  /**
   * Reported: "設定のskillsが何故か左揃えになってないし、しかも横スクロールも発生してる / 適切な折り返し
   * (タイムラインのgoalカードのように)と本文のシンタックスハイライトも実装して".
   *
   * Two causes in the CSS: the name column was `auto`, which sizes to the WIDEST content so a long
   * skill name pushed the row past the panel; and the body was `white-space: pre-wrap` on a `<pre>`,
   * so a SKILL.md's own `##` and fence markers showed AND long unbroken paths still overflowed.
   *
   * The wrapping contract must match the goal card's: break anywhere, never scroll horizontally.
   */
  const css = stripSourceComments(await readSource("frontend/app.css"));

  const head = cssRuleBody(css, ".skillhead");
  assert.match(
    head,
    /grid-template-columns:\s*12px minmax\(0,\s*1fr\)/,
    "an `auto` text column sizes to its longest content and forces a horizontal scrollbar",
  );

  const body = cssRuleBody(css, ".skillbody");
  assert.match(body, /overflow-wrap:\s*anywhere/, "long paths and commands must wrap, as the goal card does");
  assert.match(body, /overflow-x:\s*hidden/, "and the body must not scroll sideways");
  assert.doesNotMatch(
    body,
    /white-space:\s*pre-wrap/,
    "the body is rendered markdown now, so pre-wrap would double-space every line",
  );
  // syntax surface for code inside the body: the same treatment a message gets
  assert.match(css, /\.skillbody pre\s*\{[^}]*background/, "fenced code needs a surface of its own");
  assert.match(css, /\.skillbody code\s*\{[^}]*background/, "inline code needs one too");
});

test("the skills ROW can actually shrink: nowrap and min-width are overridden (#ui)", async () => {
  /**
   * The horizontal scrollbar persisted through two attempts at this fix, and both times the reason
   * was a rule one level UP from where I was looking. MEASURED in headless Firefox, a long skill
   * name inside a 358px panel:
   *
   *   - the name was 321px wide but the ROW stayed 694px → a flex item's automatic minimum size is
   *     its content, so the row itself needs `min-width: 0`, not just the text;
   *   - even then the header stayed 694px, because the GLOBAL `button { white-space: nowrap }`
   *     stopped the label wrapping at all. That global is right for a short fixed label and wrong
   *     for a header that carries a name and a description.
   *
   * After both: 360/360, no h-scroll. So the contract is three declarations, and losing any one of
   * them brings the scrollbar back.
   */
  const css = stripSourceComments(await readSource("frontend/app.css"));
  for (const sel of [".skilllist", ".skillrow"]) {
    assert.match(
      cssRuleBody(css, sel),
      /min-width:\s*0/,
      `${sel} is a flex item — without min-width:0 it cannot shrink below its content`,
    );
  }
  const head = cssRuleBody(css, ".skillhead");
  assert.match(head, /white-space:\s*normal/, "the global button nowrap must be undone here");
  assert.match(head, /display:\s*grid/, "and the global inline-flex must be undone too");
  assert.match(head, /grid-template-columns:\s*12px minmax\(0,\s*1fr\)/);
});

test("a fenced block in a skill body WRAPS instead of growing its own scrollbar (#ui)", async () => {
  /**
   * Reported: "skillsの本文を展開すると横スクロールが出る".
   *
   * The bar is INSIDE the code block, not on the panel: `.skillbody pre` carried `overflow-x: auto`,
   * so every fenced block scrolled sideways on its own. MEASURED with a long command, the `pre`
   * reported 486px of content inside a 263px box.
   *
   * The goal card has no such bar because it wraps, and that is what was asked for ("タイムラインの
   * goalカードのように"). Wrapping is also right for this content: a shell command broken across lines
   * is still readable, while a scrollbar hides the end of it.
   *
   * A TABLE keeps its scroller — columns cannot wrap — but must stay capped so it cannot push the
   * panel sideways.
   */
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const pre = cssRuleBody(css, ".skillbody pre");
  assert.match(pre, /overflow-x:\s*hidden/, "the fenced block must not scroll sideways");
  assert.match(pre, /white-space:\s*pre-wrap/, "it wraps, like the goal card");

  const table = cssRuleBody(css, ".skillbody table");
  assert.match(table, /max-width:\s*100%/, "a wide table must not push the panel");
});

test("every code surface in a tool card shares ONE depth (#ui)", async () => {
  /**
   * Reported: "ツールカードでツール引数はカードの背景色なのに、ツール出力は一段深い色になってる /
   * bash ではどっちも一段深い".
   *
   * Two different renderers: the output used `.toolbody`, the arguments a bare `<div class="mono">`
   * with no surface at all. The fix was to route both through the same surface, so the property that
   * matters is a CSS one: ONE `.toolbody` rule, deriving from the same token, is what both depend on.
   *
   * Asserted as the CSS CONTRACT rather than by grepping for `argsBlock`/`codeBlock` in App.tsx: those
   * are implementation names that move between files (they now live in `components/rows.tsx`), and a
   * source regex passes or fails on the spelling rather than on what the operator sees.
   */
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const body = cssRuleBody(css, ".toolbody");
  assert.match(
    body,
    /background:[^;]*var\(--bg-darkest\)/,
    "the shared code surface must derive from `--bg-darkest`, which is what makes input and output " +
      "the same depth",
  );
  // and it must actually be a surface: a rule with no background would leave the card's own colour,
  // which is the inconsistency that was reported
  assert.match(body, /border-radius:/, "and it must read as a distinct block");
});

test("tool content is highlighted by LANGUAGE, not by file path (#ui)", async () => {
  /**
   * Asked for as "bashコードや、ツール入力JSONとかをShikiハイライトできるといいかも". Tool content has
   * no path, so `langForPath` cannot help — the entry point takes a language NAME.
   */
  const shiki = await readSource("frontend/lib/shiki.ts");
  assert.match(
    shiki,
    /export async function\* highlightLangChunks\(/,
    "a language-based entry point must exist, because tool content has no file path to derive one from",
  );
  // ...and the two languages a tool card needs must be BUNDLED, or the call silently yields nothing
  for (const lang of ["json", "shellscript"]) {
    assert.match(
      shiki,
      new RegExp(`^\\s*${lang}: \\(\\) => import\\("shiki/langs/${lang}\\.mjs"\\)`, "m"),
      `${lang} must have a grammar loader — an unregistered language returns no chunks and the ` +
        `caller silently falls back to plain text`,
    );
  }
});

test("the PROMPT BOX is visibly translucent, not only nominally (#ui)", async () => {
  /**
   * Reported: "darkテーマでプロンプト欄が背景透過されない", then "たぶん、ほぼ透けてないじゃなくて全く
   * 透けてないだと思う".
   *
   * MEASURED in Firefox with the operator's actual theme (surfaceAlpha 0.87, backgroundDim 0.9):
   * the composer computed to `alpha 0.87`. So the property was translucent and the RESULT looked
   * solid — 0.87 over an already-dimmed image is imperceptible. The report was a correct reading of
   * the pixels even though the computed value was never 1.
   *
   * The composer therefore sits BELOW the base: above the chip level (base − 0.12, which is light
   * enough for small code blocks) and near the panel level, so it reads as a surface you can still
   * see through. MEASURED after: 0.79 against chips at 0.75 and panels at 0.82.
   */
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const rule = cssRuleBody(css, 'html[data-bg-image="on"] .composer form');
  assert.ok(rule, "the composer needs a wallpaper-specific rule at all");
  /**
   * The rule reads `--surface-alpha-composer`, which is where the subtraction lives now (a token,
   * so the ask_user reply box can be the same surface without repeating the formula). Assert on
   * the TOKEN's definition: a rule that names it does not by itself prove it sits below the base,
   * and "below the base" is the whole point — at the base it computes near-opaque and looks solid.
   */
  assert.match(
    rule,
    /var\(--surface-alpha-composer/,
    "the composer must paint from the composer alpha token, so it cannot drift from the token",
  );
  // search the whole sheet: the token lives in the `html[data-bg-image="on"]` block, and
  // cssRuleBody throws for a selector that does not exist rather than returning ""
  assert.match(
    css,
    /--surface-alpha-composer:\s*max\([^;]*var\(--surface-alpha[^;]*-\s*0?\.\d+\s*\)/, 
    "the composer alpha must be DERIVED from --surface-alpha minus a visible step, or it " +
      "computes near-opaque and looks solid (#ui)",
  );
  // and it must keep --bg-light's colour, so it still reads as a raised surface
  assert.match(rule, /var\(--bg-light-solid/, "the colour stays the control surface's");
});

test("a NESTED tool body steps back instead of repeating its parent's fill (#ui)", async () => {
  /**
   * Reported: "ツールカードのネストされたとこの背景色をいい感じに統一".
   *
   * A tool card can contain another — a sub-agent's tool row, or a `wait_children` result carrying
   * output. Both painted `--bg-darkest`, so the inner block was the SAME colour as the outer and the
   * two read as one undifferentiated slab.
   *
   * Nesting now steps clearly toward the page — a container is denser than what it holds, and the
   * deepest content is the most open surface in the app. MEASURED: 0.70 → 0.49 → 0.385, against a
   * prompt box at 0.74 and panels at 0.77. An intermediate attempt used 92% and gave 0.64, which was
   * reported as "内側の要素があまり透明じゃなくて微妙" — too close to the parent to read as a layer.
   */
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const nested = cssRuleBody(css, ".toolbody .toolbody");
  assert.ok(nested, "a nested body needs its own rule, or it repeats the parent's colour");
  assert.match(nested, /color-mix\(/, "it must step toward transparent, not pick another solid");
  const deep = cssRuleBody(css, ".toolbody .toolbody .toolbody");
  assert.match(deep, /color-mix\(/, "a third level keeps stepping rather than vanishing");
  assert.match(deep, /border:/, "with a border carrying the cue");
});
