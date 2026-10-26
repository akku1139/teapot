import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const MAX_EDGE = 2560;

export interface ImageTool {
  name: string;
  kind: "ffmpeg" | "magick" | "convert";
}

export interface DetectResult {
  tool: ImageTool | null;
  found: { name: string; present: boolean }[];
}

const CANDIDATES: { name: string; kind: ImageTool["kind"]; probe: string[] }[] = [
  { name: "ffmpeg", kind: "ffmpeg", probe: ["-version"] },
  { name: "magick", kind: "magick", probe: ["-version"] },
  { name: "convert", kind: "convert", probe: ["-version"] },
];

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
    if (present && !tool) tool = { name: c.name, kind: c.kind };
  }
  return { tool, found };
}

export function resizeArgs(tool: ImageTool, src: string, out: string, width = MAX_EDGE): string[] {
  const scale = `scale='min(${width},iw)':'min(${width},ih)':force_original_aspect_ratio=decrease`;
  if (tool.kind === "ffmpeg") {
    return ["-y", "-loglevel", "error", "-i", src, "-vf", scale, "-frames:v", "1", out];
  }
  const geometry = `${width}x${width}>`; 
  return [`${src}[0]`, "-resize", geometry, "-strip", out];
}

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
  if (bytesAfter >= bytesBefore) {
    await fs.rm(out, { force: true }).catch(() => {});
    return { resized: false, reason: "re-encode was not smaller", bytesBefore, bytesAfter };
  }
  return { resized: true, bytesBefore, bytesAfter };
}

export function scaledName(name: string): string {
  const ext = path.extname(name);
  return `${path.basename(name, ext)}-w${ext}`;
}

export function widthName(name: string, width: number): string {
  const ext = path.extname(name);
  return `${path.basename(name, ext)}-w${width}${ext}`;
}
