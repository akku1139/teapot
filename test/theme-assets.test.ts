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

const base = { id: "custom-1", label: "t", mode: "dark" as const, palette: { ...DEFAULT_PALETTE } };

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

  const got = await app.request(url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.match(got.headers.get("cache-control") ?? "", /immutable/, "the name is never reused");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
});

test("an asset name that is not the exact grammar is refused (#assets)", async () => {
  const dataDir = mkdtempInRootSync("assets2-");
  const app = buildApp(mkMaster(dataDir));

  const { writeFileSync, mkdirSync } = await import("node:fs");
  const path = await import("node:path");
  mkdirSync(path.join(dataDir, "assets"), { recursive: true });
  writeFileSync(path.join(dataDir, "assets", "notes.txt"), "secret");

  for (const bad of ["notes.txt", "abc.png", "a".repeat(32) + ".txt", "short.png"]) {
    const r = await app.request(`/api/assets/${bad}`);
    assert.equal(r.status, 404, `${bad} must not be served — it is not a name this server mints`);
  }
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
  for (const ok of [
    "/api/assets/" + "a".repeat(32) + ".png",
    "data:image/png;base64,AAAA",
    "https://example.com/bg.jpg",
  ]) {
    const t = sanitizeTheme({ ...base, backgroundImage: ok });
    assert.equal(t?.backgroundImage, ok, `${ok} must be accepted`);
  }
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
  const { opaque } = await import("../frontend/lib/theme-store.ts");
  assert.equal(opaque("#1a1c2200"), "#1a1c22", "alpha must be stripped");
  assert.equal(opaque("#1A1C22"), "#1A1C22", "an opaque colour is unchanged");
  assert.equal(opaque("rgb(0 0 0 / 0%)"), "rgb(0 0 0 / 0%)", "non-hex is left alone");

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
  assert.match(
    cssRuleBody(css, 'html[data-bg-image="on"] .embed'),
    /background-image:\s*none/,
    "and must not paint a gradient over it",
  );
});

test("the auth choice is derived from the saved headers, not reset (#mcpui)", async () => {
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

  const value = (h: Record<string, string>) =>
    Object.keys(h).length === 1 ? (h.Authorization ?? "").replace(/^Bearer /i, "") : "";
  assert.equal(value({ Authorization: "Bearer sk-123" }), "sk-123");
});

test("surfaceAlpha is CLAMPED to a readable floor (#ui)", async () => {
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
  const t = sanitizeTheme({ ...base, backgroundImage: "/api/assets/" + "a".repeat(32) + ".png" });
  assert.ok(t);
  assert.equal(t.surfaceAlpha, undefined);
});

test("every surface level has an alpha-stripped variant when an image is set (#ui)", async () => {
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

  applyCustomTheme(root, null);
  for (const name of ["--bg-darkest-solid", "--bg-dark-solid", "--bg-mid-solid", "--bg-light-solid"]) {
    assert.equal(writes[name], undefined, `${name} must be removed with the image`);
  }
});

test("a code block paints ONE surface, not a pre and a code stacked (#ui)", async () => {
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const inner = cssRuleBody(css, 'html[data-bg-image="on"] .content pre code');
  assert.match(
    inner,
    /background:\s*none/,
    "the code inside a pre must not paint its own surface, or the block shows a double frame",
  );
  assert.match(cssRuleBody(css, ".content pre"), /background:/);
});

test("with a wallpaper, the surface variables are left to the STYLESHEET (#ui)", async () => {
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

  const noImg = make();
  applyCustomTheme(noImg.root, { ...base, palette: { ...DEFAULT_PALETTE, bgDarkest: "#1a1c22" } } as never);
  assert.equal(noImg.writes["--bg-darkest"], "#1a1c22");
});

test("the transparency scale is LAYERED, not one alpha for every surface (#ui)", async () => {
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const scale = cssRuleBody(css, 'html[data-bg-image="on"]');
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
  assert.match(scale, /var\(--surface-alpha,\s*0?\.\d+\)/);
});

test("the appearance section's image block is NOT forced fully opaque (#ui)", async () => {
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
  assert.match(css, /\.skillbody pre\s*\{[^}]*background/, "fenced code needs a surface of its own");
  assert.match(css, /\.skillbody code\s*\{[^}]*background/, "inline code needs one too");
});

test("the skills ROW can actually shrink: nowrap and min-width are overridden (#ui)", async () => {
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
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const pre = cssRuleBody(css, ".skillbody pre");
  assert.match(pre, /overflow-x:\s*hidden/, "the fenced block must not scroll sideways");
  assert.match(pre, /white-space:\s*pre-wrap/, "it wraps, like the goal card");

  const table = cssRuleBody(css, ".skillbody table");
  assert.match(table, /max-width:\s*100%/, "a wide table must not push the panel");
});

test("every code surface in a tool card shares ONE depth (#ui)", async () => {
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const body = cssRuleBody(css, ".toolbody");
  assert.match(
    body,
    /background:[^;]*var\(--bg-darkest\)/,
    "the shared code surface must derive from `--bg-darkest`, which is what makes input and output " +
      "the same depth",
  );
  assert.match(body, /border-radius:/, "and it must read as a distinct block");
});

test("tool content is highlighted by LANGUAGE, not by file path (#ui)", async () => {
  const { highlightLangChunks } = await import("../frontend/lib/shiki.ts");
  for (const [lang, code] of [
    ["json", '{"a":1}'],
    ["shellscript", "ls -la /tmp"],
  ] as const) {
    let html = "";
    for await (const chunk of highlightLangChunks(lang, code)) html += chunk;
    assert.ok(html.length > 0, `${lang} must produce output — an unregistered grammar yields nothing`);
    assert.match(html, /--shiki-/, `${lang} must be tokenised, not echoed back as plain text`);
    assert.match(html, /a/, "and the content must survive");
  }
});

test("the PROMPT BOX is visibly translucent, not only nominally (#ui)", async () => {
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const rule = cssRuleBody(css, 'html[data-bg-image="on"] .composer form');
  assert.ok(rule, "the composer needs a wallpaper-specific rule at all");
  assert.match(
    rule,
    /var\(--surface-alpha-composer/,
    "the composer must paint from the composer alpha token, so it cannot drift from the token",
  );
  assert.match(
    css,
    /--surface-alpha-composer:\s*max\([^;]*var\(--surface-alpha[^;]*-\s*0?\.\d+\s*\)/, 
    "the composer alpha must be DERIVED from --surface-alpha minus a visible step, or it " +
      "computes near-opaque and looks solid (#ui)",
  );
  assert.match(rule, /var\(--bg-light-solid/, "the colour stays the control surface's");
});

test("a NESTED tool body steps back instead of repeating its parent's fill (#ui)", async () => {
  const css = stripSourceComments(await readSource("frontend/app.css"));
  const nested = cssRuleBody(css, ".toolbody .toolbody");
  assert.ok(nested, "a nested body needs its own rule, or it repeats the parent's colour");
  assert.match(nested, /color-mix\(/, "it must step toward transparent, not pick another solid");
  const deep = cssRuleBody(css, ".toolbody .toolbody .toolbody");
  assert.match(deep, /color-mix\(/, "a third level keeps stepping rather than vanishing");
  assert.match(deep, /border:/, "with a border carrying the cue");
});

test("the MAXIMIZED composer shows the wallpaper too (#ui)", async () => {
  const css = stripSourceComments(await readSource("frontend/app.css"));
  for (const sel of [".composer.maximized", ".composer.maximized::before"]) {
    assert.ok(
      css.includes(sel),
      `${sel} must be covered by a wallpaper rule — its opaque fill hides the image (#ui)`,
    );
  }
  const at = css.indexOf('html[data-bg-image="on"] .composer.maximized');
  const body = css.slice(at, css.indexOf("}", at));
  assert.match(
    body,
    /color-mix\(/,
    "the surface must take the theme's alpha — a solid colour is what hid the wallpaper (#ui)",
  );
  assert.match(body, /--surface-alpha/, "and the alpha is the theme's own setting");
});
