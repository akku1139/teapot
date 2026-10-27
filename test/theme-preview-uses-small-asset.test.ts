import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundImageValue } from "../frontend/lib/theme-preview.ts";
import { sizedAsset, bgSrc, bgSrcSet, BG_SMALL, BG_WIDTHS } from "../frontend/lib/bg-srcset.ts";

/**
 * A theme PREVIEW must not fetch the wallpaper at full resolution.
 *
 * Reported as "appearanceのテーマカードの背景画像がオリジナルの画質で配信されてる…ので、appearanceを
 * 開くとバカ重い". The cards are 62px tall; every theme with a wallpaper was pulling its original
 * image, so opening the section downloaded megabytes to draw thumbnails.
 *
 * The asset endpoint already downsizes on demand (`?w=`, cached as `name-w640.ext`), so this is a
 * matter of ASKING for the small one — and of not corrupting URLs the endpoint does not serve.
 */
const HASH = "0123456789abcdef0123456789abcdef";

test("a preview asks for the small variant (#assets)", () => {
  const v = backgroundImageValue(`/api/assets/${HASH}.png`, BG_SMALL);
  assert.equal(v, `url("/api/assets/${HASH}.png?w=${BG_SMALL}")`);
  assert.ok(BG_SMALL <= 320, `the floor must be small enough for a 260px picker, got ${BG_SMALL}`);
});

test("no width means the original (#assets)", () => {
  // the real wallpaper still wants whatever the caller's srcset resolves to
  assert.equal(backgroundImageValue(`/api/assets/${HASH}.png`), `url("/api/assets/${HASH}.png")`);
});

test("an URL the asset endpoint does not serve is left alone (#assets)", () => {
  /**
   * Blindly appending `?w=` is wrong: a remote image gets a junk query, and a `data:` URL breaks
   * outright. Only `/api/assets/<32 hex>.<ext>` can be resized.
   */
  assert.equal(sizedAsset("https://example.com/a.png", 640), "https://example.com/a.png");
  assert.equal(sizedAsset("data:image/png;base64,AAAA", 640), "data:image/png;base64,AAAA");
  assert.equal(sizedAsset("/api/assets/notahash.png", 640), "/api/assets/notahash.png");
  assert.equal(sizedAsset(`/api/assets/${HASH}.png`, 640), `/api/assets/${HASH}.png?w=640`);
});

test("bgSrc and bgSrcSet honour the same guard (#assets)", () => {
  assert.equal(bgSrc(`/api/assets/${HASH}.png`, BG_SMALL), `/api/assets/${HASH}.png?w=${BG_SMALL}`);
  // a srcset of junk widths would be worse than none: the browser would pick one and 400
  const set = bgSrcSet("https://example.com/a.png")!;
  assert.equal(set.split(", ").length, 6, "one entry per supported width");
  assert.doesNotMatch(set, /\?w=/, "no query string may be invented for a foreign URL");
});

test("quotes in a URL cannot break out of the css value (#assets)", () => {
  const v = backgroundImageValue(`/api/assets/${HASH}.png" onload="x`, BG_SMALL);
  assert.doesNotMatch(String(v), /(?<!\\)" onload/, "the injected quote must be escaped");
});

test("the server and the client agree on the widths (#assets)", async () => {
  /**
   * `/api/assets/:name?w=` is validated against the server's own list and answers 400 for anything
   * else, so a width the client offers but the server rejects is a broken image. The two lists are in
   * different files by necessity; this is what keeps them one fact.
   */
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const api = readFileSync(path.join(import.meta.dirname, "..", "src", "server", "api.ts"), "utf8");
  const m = /const ALLOWED_WIDTHS = \[([^\]]+)\]/.exec(api);
  assert.ok(m, "precondition: the server declares its widths");
  const server = m![1]!.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
  assert.deepEqual(server, [...BG_WIDTHS], "a width only one side knows about is a 400 waiting to happen");
});

test("the theme card passes a width down (#assets)", async () => {
  /**
   * The unit above pins the helper; this pins the CALL. Without the argument the helper silently does
   * the full-resolution thing it always did, and the only symptom is a slow panel — which is exactly
   * how this was reported the first time ("appearanceを開くとバカ重い").
   */
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const src = readFileSync(
    path.join(import.meta.dirname, "..", "frontend", "components", "settings-parts.tsx"),
    "utf8",
  );
  const at = src.indexOf("backgroundImageValue(props.backgroundImage");
  assert.ok(at > 0, "the preview must call the helper");
  assert.match(
    src.slice(at, at + 80),
    /BG_SMALL/,
    "and must ask for the small variant, or the card fetches the original",
  );
});

test("the background picker's srcset starts small enough for a 260px box (#assets)", () => {
  // `sizes="260px"` with a 640 floor made the browser fetch 2.5x the pixels it could show
  assert.equal(BG_SMALL, 320);
  const set = bgSrcSet(`/api/assets/${HASH}.png`)!;
  assert.match(set, /^\/api\/assets\/[a-f0-9]+\.png\?w=320 320w,/, "the first candidate is the small one");
});
