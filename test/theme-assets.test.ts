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
import { sanitizeTheme, DEFAULT_PALETTE } from "../frontend/theme-store.ts";

const mkMaster = (dataDir: string) =>
  new Master(
    { port: 0, dataDir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, providers: {}, agents: [] } as never,
    "/dev/null",
  );

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

  const css = await (await import("./helpers/source.ts")).readSource("frontend/app.css");
  const { cssRuleBody } = await import("./helpers/css.ts");
  const rule = cssRuleBody(css, 'html[data-bg-image="on"] .embed');
  assert.match(
    rule,
    /--bg-darkest-solid/,
    "with an image set, .embed must use the ALPHA-STRIPPED surface — otherwise a translucent " +
      "palette renders tool output at zero opacity over the photo",
  );
  assert.match(rule, /background-image:\s*none/, "and must not paint a gradient over it");
});
