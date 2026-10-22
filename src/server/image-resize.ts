/**
 * Downscale an uploaded background image with a NATIVE binary, if one exists.
 *
 * ## Why this is not done in the browser
 *
 * A wallpaper is displayed with `background-size: cover` at the window's size — a 6000x4000 phone
 * photo is never shown at more than ~2000x1200, but the browser still decodes the full thing and
 * keeps it decoded. Reported as "背景画像が大きいとブラウザがリサイズでかなり重くなっちゃう".
 * Resizing once on the server costs a few hundred milliseconds at upload and makes every later
 * repaint cheap.
 *
 * `ffmpeg.wasm` would avoid the external dependency at the cost of tens of MB of wasm to do work
 * that a native binary does in one call. So: use whatever native tool is present, and when none
 * is, keep the original. A missing optimiser must never fail an upload — the image still works,
 * it is just as heavy as before.
 *
 * ## Why execFile and not a shell
 *
 * The source path is derived from a server-generated `randomUUID`, but it still reaches a `-i`
 * argument, so arguments are passed as an ARRAY with no shell in between. Nothing about an
 * uploaded file can be read as a flag or a command.
 */
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** long edge, in pixels. Deliberately above any realistic window: `cover` on a 4K display at
 *  devicePixelRatio 2 still lands near this, so this is a quality floor, not a UX cap. */
export const MAX_EDGE = 2560;

/** a tool we can drive, and how to build its argv */
export interface ImageTool {
  name: string;
  /** the kind of invocation this build understands */
  kind: "ffmpeg" | "magick" | "convert";
}

export interface DetectResult {
  /** the tool that will be used, or null when nothing is available */
  tool: ImageTool | null;
  /** every candidate and whether it was found, for the settings panel */
  found: { name: string; present: boolean }[];
}

const CANDIDATES: { name: string; kind: ImageTool["kind"]; probe: string[] }[] = [
  // ffmpeg first: it is the one most likely to be on a machine that has neither imagemagick nor
  // a package manager, and `-vf scale` is a single pass.
  { name: "ffmpeg", kind: "ffmpeg", probe: ["-version"] },
  { name: "magick", kind: "magick", probe: ["-version"] },
  // ImageMagick 6 ships `convert` only; same invocation, different binary name
  { name: "convert", kind: "convert", probe: ["-version"] },
];

/**
 * Which image tools exist? Probing runs them, so the answer is what actually works here rather
 * than what a PATH scan suggests — a broken symlink or a stub shim is not a usable optimiser.
 */
export async function detectImageTools(): Promise<DetectResult> {
  const found: { name: string; present: boolean }[] = [];
  let tool: ImageTool | null = null;
  for (const c of CANDIDATES) {
    let present = false;
    try {
      await run(c.name, c.probe, { timeout: 5000 });
      present = true;
    } catch {
      present = false;
    }
    found.push({ name: c.name, present });
    // `convert` is a common name for unrelated programs; only take it after the two specific
    // ones, which is what the CANDIDATES order already does.
    if (present && !tool) tool = { name: c.name, kind: c.kind };
  }
  return { tool, found };
}

/**
 * build the argv for a downscale into `out`.
 *
 * `width` is the LONG EDGE to fit within — the same meaning as `srcset`'s `w` descriptors, which
 * is what lets the client's chosen width be honoured directly.
 */
export function resizeArgs(tool: ImageTool, src: string, out: string, width = MAX_EDGE): string[] {
  const scale = `scale='min(${width},iw)':'min(${width},ih)':force_original_aspect_ratio=decrease`;
  if (tool.kind === "ffmpeg") {
    // `-y` overwrite, `-frames:v 1` in case the input is an animated GIF (we want a still)
    return ["-y", "-loglevel", "error", "-i", src, "-vf", scale, "-frames:v", "1", out];
  }
  const geometry = `${width}x${width}>`; // only shrink, never enlarge
  return [`${src}[0]`, "-resize", geometry, "-strip", out];
}

/**
 * Downscale `src` into `out`. Returns whether it did anything, and never throws.
 *
 * "Did nothing" is a normal outcome: no tool installed, an image already small enough, or a tool
 * that failed on this particular file. The caller keeps the original in every one of those cases,
 * so an upload is never lost to an optimiser problem.
 */
export async function downscaleImage(
  src: string,
  out: string,
  tool: ImageTool | null,
  width = MAX_EDGE,
): Promise<{ resized: boolean; reason?: string; bytesBefore?: number; bytesAfter?: number }> {
  if (!tool) return { resized: false, reason: "no image tool installed" };
  let bytesBefore: number;
  try {
    bytesBefore = (await fs.stat(src)).size;
  } catch {
    return { resized: false, reason: "source missing" };
  }
  try {
    await run(tool.name, resizeArgs(tool, src, out, width), { timeout: 60_000 });
  } catch (err) {
    return { resized: false, reason: `${tool.name} failed: ${(err as Error).message.slice(0, 120)}` };
  }
  if (!existsSync(out)) return { resized: false, reason: `${tool.name} produced no output` };
  const bytesAfter = (await fs.stat(out)).size;
  /**
   * Keep whichever is SMALLER, and delete the other.
   *
   * A re-encode can GROW a file — an already-optimised WebP fed through a lossy JPEG encoder is
   * the usual way. Shipping the larger of the two would be strictly worse in both transfer and
   * decode, so the comparison decides and the loser is removed.
   */
  if (bytesAfter >= bytesBefore) {
    await fs.rm(out, { force: true }).catch(() => {});
    return { resized: false, reason: "re-encode was not smaller", bytesBefore, bytesAfter };
  }
  return { resized: true, bytesBefore, bytesAfter };
}

/** the scaled filename for an asset: same stem, `-w` suffix, same extension */
export function scaledName(name: string): string {
  const ext = path.extname(name);
  return `${path.basename(name, ext)}-w${ext}`;
}

/**
 * The cached filename for a specific width: `<stem>-w<width>.<ext>`.
 *
 * Kept within `assetName()`'s grammar (`[a-f0-9]{32}\.(ext)`) is NOT possible with a width in the
 * name, so these derived files are never served through `/api/assets/:name` directly — they are
 * read internally and their bytes returned. That is deliberate: the public route only accepts the
 * 32-hex form, so a derived name can never be requested as if it were an original.
 */
export function widthName(name: string, width: number): string {
  const ext = path.extname(name);
  return `${path.basename(name, ext)}-w${width}${ext}`;
}
