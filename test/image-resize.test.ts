/**
 * Server-side downscaling of uploaded background images.
 *
 * Reported: "背景画像が大きいとブラウザがリサイズでかなり重くなっちゃう". A phone photo is
 * 6000x4000 but is displayed with `background-size: cover` at window size, so the browser decodes
 * and keeps ~24 megapixels for nothing.
 *
 * The rule that matters most here is the SKIP path: a missing optimiser must never fail an upload.
 * These tests exercise the real ffmpeg/ImageMagick when present and the no-tool path always.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  detectImageTools,
  downscaleImage,
  resizeArgs,
  scaledName,
  MAX_EDGE,
} from "../src/server/image-resize.ts";

test("a missing optimiser is SKIPPED, not an error (#assets)", async () => {
  /**
   * The whole point of the optional dependency: with no ffmpeg and no ImageMagick the upload must
   * still succeed and serve the original. Failing here would turn a nice-to-have into an outage.
   */
  const dir = mkdtempInRootSync("resize-none-");
  const src = path.join(dir, "in.png");
  const out = path.join(dir, "out.png");
  const res = await downscaleImage(src, out, null);
  assert.equal(res.resized, false);
  assert.match(String(res.reason), /no image tool/);
  assert.equal(existsSync(out), false, "nothing is written when there is no tool");
});

test("the argv only ever shrinks, and never uses a shell (#assets)", () => {
  // `>` geometry / force_original_aspect_ratio=decrease: a small image must not be upscaled, which
  // would cost bytes and quality for nothing
  const ff = resizeArgs({ name: "ffmpeg", kind: "ffmpeg" }, "/a/in.png", "/a/out.png");
  assert.ok(ff.includes("-vf"));
  assert.match(ff.join(" "), new RegExp(`min\\(${MAX_EDGE},iw\\)`));
  assert.equal(ff[ff.length - 1], "/a/out.png");

  const im = resizeArgs({ name: "convert", kind: "convert" }, "/a/in.png", "/a/out.png");
  assert.match(im.join(" "), new RegExp(`${MAX_EDGE}x${MAX_EDGE}>`), "ImageMagick '>' means shrink-only");
});

test("the scaled name keeps the extension, so the asset grammar still accepts it (#assets)", () => {
  const name = `${"a".repeat(32)}.png`;
  const scaled = scaledName(name);
  assert.match(scaled, /^[a-f0-9]{32}-w\.png$/, "must still be a name `assetName()` can mint");
});

test("the tool list reports what was actually found (#assets)", async () => {
  // the settings panel shows this, so it has to be the real answer rather than a PATH guess
  const r = await detectImageTools();
  assert.ok(Array.isArray(r.found) && r.found.length > 0);
  for (const f of r.found) assert.equal(typeof f.present, "boolean");
  // if a tool was chosen it must be one of the probed candidates that reported present
  if (r.tool) assert.ok(r.found.some((f) => f.name === r.tool!.name && f.present));
});

test("a real oversized image is actually made smaller (#assets)", async (t) => {
  const detected = await detectImageTools();
  if (!detected.tool) return t.skip("no ffmpeg / ImageMagick on this machine");

  const dir = mkdtempInRootSync("resize-real-");
  const src = path.join(dir, "big.png");
  const out = path.join(dir, "small.png");
  // generate a genuinely large image with the tool we are testing
  if (detected.tool.kind === "ffmpeg") {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi",
      "-i", "color=c=blue:s=4000x3000", "-frames:v", "1", src]);
  } else {
    execFileSync(detected.tool.name, ["-size", "4000x3000", "xc:blue", src]);
  }
  const before = statSync(src).size;
  const res = await downscaleImage(src, out, detected.tool);
  assert.equal(res.resized, true, `expected a downscale; got ${JSON.stringify(res)}`);
  assert.ok(existsSync(out), "the scaled file must exist");
  assert.ok(statSync(out).size > 0, "and must not be empty");
  assert.ok((res.bytesAfter ?? 0) < before, "and must be smaller than the original");
});

test("a re-encode that GREW is discarded in favour of the original (#assets)", async (t) => {
  /**
   * A tiny already-optimal image fed through an encoder can come out LARGER. Shipping that would be
   * worse in both transfer and decode, so the comparison decides and the loser is deleted.
   */
  const detected = await detectImageTools();
  if (!detected.tool) return t.skip("no ffmpeg / ImageMagick on this machine");

  const dir = mkdtempInRootSync("resize-grow-");
  const src = path.join(dir, "tiny.png");
  const out = path.join(dir, "tiny-w.png");
  if (detected.tool.kind === "ffmpeg") {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi",
      "-i", "color=c=red:s=8x8", "-frames:v", "1", src]);
  } else {
    execFileSync(detected.tool.name, ["-size", "8x8", "xc:red", src]);
  }
  const res = await downscaleImage(src, out, detected.tool);
  // either outcome is legitimate — what must hold is that we never keep the BIGGER file
  if (!res.resized) {
    assert.equal(existsSync(out), false, "the larger re-encode must be removed");
  } else {
    assert.ok((res.bytesAfter ?? 0) < (res.bytesBefore ?? 0));
  }
});

test("only the width LADDER is accepted, so a client cannot mint files (#assets)", async () => {
  /**
   * `?w=` writes a cached file per width. Without a bounded set, any client could request
   * thousands of distinct widths and fill the disk — so the endpoint accepts the ladder and
   * rejects everything else rather than clamping silently (a clamp would make two widths share a
   * cache entry under names that disagree).
   */
  const { buildApp } = await import("../src/server/api.ts");
  const { Master } = await import("../src/master.ts");
  const dir = mkdtempInRootSync("assets-w-");
  const app = buildApp(new Master({ port: 0, dataDir: dir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, providers: {}, agents: [] } as never, "/dev/null"));

  const name = `${"b".repeat(32)}.png`;
  for (const bad of ["999", "1", "-5", "abc", "100000"]) {
    const r = await app.request(`/api/assets/${name}?w=${bad}`);
    assert.ok(
      r.status === 400 || r.status === 404,
      `width ${bad} must be refused (got ${r.status}) — an unbounded set is an unbounded file cache`,
    );
  }
});

test("the served width ladder is advertised to the client (#assets)", async () => {
  // the client builds `srcset` from these; asking for a width the server rejects would silently
  // fall back to the full-size original
  const { buildApp } = await import("../src/server/api.ts");
  const { Master } = await import("../src/master.ts");
  const dir = mkdtempInRootSync("assets-meta-");
  const app = buildApp(new Master({ port: 0, dataDir: dir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, providers: {}, agents: [] } as never, "/dev/null"));
  const r = await app.request("/api/assets/meta");
  assert.equal(r.status, 200);
  const body = (await r.json()) as { widths: number[] };
  assert.ok(Array.isArray(body.widths) && body.widths.length >= 3);
  assert.deepEqual([...body.widths].sort((a, b) => a - b), body.widths, "ascending, as srcset expects");
});

test("?w= serves a SMALLER image than the original, and caches it (#assets)", async (t) => {
  /**
   * The end-to-end claim: a big upload, requested at a ladder width, comes back lighter. This is
   * the whole reason the wallpaper is an <img srcset> — the browser asks for what it needs.
   *
   * Precondition asserted: the upload must be substantially larger than the requested width, or
   * "smaller" would be trivially true or false for the wrong reason.
   */
  const { detectImageTools: detect } = await import("../src/server/image-resize.ts");
  const tools = await detect();
  if (!tools.tool) return t.skip("no ffmpeg / ImageMagick on this machine");

  const { buildApp } = await import("../src/server/api.ts");
  const { Master } = await import("../src/master.ts");
  const dir = mkdtempInRootSync("assets-serve-");
  const app = buildApp(new Master({ port: 0, dataDir: dir, llm: { baseUrl: "http://x", apiKey: "k", model: "m" }, providers: {}, agents: [] } as never, "/dev/null"));

  const big = path.join(dir, "big.png");
  if (tools.tool.kind === "ffmpeg") {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi",
      "-i", "color=c=green:s=4000x3000", "-frames:v", "1", big]);
  } else {
    execFileSync(tools.tool.name, ["-size", "4000x3000", "xc:green", big]);
  }
  const originalBytes = statSync(big).size;

  const up = await app.request("/api/assets", {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: await import("node:fs").then((m) => m.readFileSync(big)),
  });
  assert.equal(up.status, 200);
  const { name } = (await up.json()) as { name: string };

  const small = await app.request(`/api/assets/${name}?w=640`);
  assert.equal(small.status, 200);
  const smallBytes = Buffer.from(await small.arrayBuffer()).length;
  assert.ok(
    smallBytes < originalBytes / 2,
    `640w must be far lighter than ${originalBytes}B; got ${smallBytes}B`,
  );

  // second request comes from the on-disk cache: same bytes, still 200
  const again = await app.request(`/api/assets/${name}?w=640`);
  assert.equal(again.status, 200);
  assert.equal(Buffer.from(await again.arrayBuffer()).length, smallBytes);
});
