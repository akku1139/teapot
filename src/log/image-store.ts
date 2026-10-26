import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Image bytes live in a `blobs/` directory INSIDE the session, beside `chat.jsonl`.
 *
 * Three reasons, in order of how much they matter:
 *
 * 1. **Deleting a session must delete its images.** The operator's data dir reached 533MB of logs with
 *    a 578KB JPEG per read; being able to `rm -r` one session and reclaim every byte is the point. A
 *    shared store would leave orphans that no session owns and nobody dares delete.
 * 2. base64 is 4/3 the size and inflates `chat.jsonl`, which is re-read on every replay. MEASURED: the
 *    median tool result is 229 bytes, so one picture would dwarf a thousand ordinary rows.
 * 3. JSON is a text format. Megabytes of encoded binary inside it make every reader of the log — replay,
 *    grep, the timeline, a person with `less` — pay for data almost none of them want.
 *
 * NOT `assets/`: that is the WALLPAPER store, with its own resize cache, URL shape and lifetime (a
 * wallpaper outlives every session). Two lifecycles in one directory is how "safe to delete" stops
 * being true.
 *
 * Names are `sha256` of the content, so a write is idempotent and two different images cannot share a
 * filename.
 */
const BLOBS_DIR = "blobs";

/**
 * Write a data URL to `images/` and return the reference to store in the log — `assets/<sha256>.<ext>`.
 *
 * Anything already addressed by a URL (`http(s):`, or a reference we wrote earlier) passes through
 * untouched: it is not ours to copy, and re-encoding would lose the original bytes.
 */
export async function storeImage(imagesDir: string, dataUrl: string): Promise<{ ref: string; bytes: number }> {
  if (!dataUrl.startsWith("data:")) return { ref: dataUrl, bytes: 0 };
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(5, comma);
  if (comma < 0 || !header.includes("base64")) throw new Error("image data URL is not base64");
  const mime = header.split(";")[0] || "application/octet-stream";
  const buf = Buffer.from(dataUrl.slice(comma + 1), "base64");
  const name = `${crypto.createHash("sha256").update(buf).digest("hex")}${extFor(mime)}`;
  await fs.mkdir(imagesDir, { recursive: true });
  const dest = path.join(imagesDir, name);
  // content-addressed, so an existing file already holds these bytes
  try {
    await fs.writeFile(dest, buf, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return { ref: `${BLOBS_DIR}/${name}`, bytes: buf.length };
}

/**
 * Resolve a stored reference back to something the model can receive.
 *
 * `assets/<name>` is read from disk and encoded as a data URL at REQUEST time — the only point where
 * the bytes have to be inline. A plain `data:` or `http(s):` value (an older session) is returned
 * as-is, so logs written before this existed keep working.
 */
export async function resolveImage(imagesDir: string, ref: string): Promise<string | null> {
  if (!ref.startsWith(`${BLOBS_DIR}/`)) return ref;
  const name = ref.slice(BLOBS_DIR.length + 1);
  // a stored name is a basename; refuse anything that tries to climb out of the directory
  if (!name || name !== path.basename(name)) return null;
  try {
    const buf = await fs.readFile(path.join(imagesDir, name));
    return `data:${mimeForExt(path.extname(name))};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Resolve every image of one stored event, in order, dropping any whose bytes are gone.
 *
 * A missing file is DROPPED rather than faked: the text beside it stays, but an unreadable reference
 * must not become an invented picture or a request the API rejects.
 */
export async function resolveImages(imagesDir: string, refs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of refs) {
    const resolved = await resolveImage(imagesDir, r);
    if (resolved) out.push(resolved);
  }
  return out;
}

function extFor(mime: string): string {
  switch (mime) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
