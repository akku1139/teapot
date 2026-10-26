import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { executeTool } from "../src/agent/tools.ts";
import { useTempDir } from "./helpers/tmp.ts";

/**
 * `read_file` on an image must hand the MODEL the picture, not a refusal and not raw bytes.
 *
 * The history matters, because "this used to work" is how this was reported:
 * - `d907af3` made `read_file` refuse binary files. That was correct as a bug fix — `readText`
 *   decodes as utf8 unconditionally, so a picture arrived as mangled bytes.
 * - But there was never an agent-side image path. The multimodal commit (`257333a`) was the USER's
 *   composer → `/prompt` route. MEASURED: `git log -S"data:image" -- src/agent/tools.ts` was empty.
 *
 * So the asymmetry the operator hit — a user can attach a picture, the agent cannot — was real and
 * total, not a regression.
 *
 * The contract: images come back `ok: true` with `image.url` as a data URL; text is unchanged; a real
 * binary (no image mime) is still refused, because returning mangled bytes was the original bug.
 */
const ctx = (dir: string) => ({
  cwd: dir,
  stateDir: dir,
  defaultTimeoutMs: 30_000,
  maxOutputBytes: 100_000,
});

const read = async (dir: string, file: string) =>
  executeTool("read_file", JSON.stringify({ path: file }), ctx(dir) as never);

test("a JPEG is returned as an image the model can see (#images)", async () => {
  await useTempDir("imgread-", async (dir) => {
    await fs.writeFile(path.join(dir, "card.jpg"), Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex"));
    const r = await read(dir, "card.jpg");
    assert.equal(r.ok, true, "an image is not an error");
    assert.ok(r.image, "and it must arrive as an image, or the model is blind to it");
    assert.match(r.image.url, /^data:image\/jpeg;base64,/, "as a data URL the wire format accepts");
    assert.equal(r.image.name, "card.jpg");
    // the text still says what happened — it is what the log and the timeline show
    assert.match(r.result, /JPEG image/);
    assert.match(r.result, /attached to this message/, "so the model knows it is looking at the picture");
  });
});

test("PNG, GIF and WEBP are recognised too (#images)", async () => {
  await useTempDir("imgread2-", async (dir) => {
    const cases: [string, Buffer, string][] = [
      ["a.png", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), "image/png"],
      ["b.gif", Buffer.from("GIF89a", "latin1"), "image/gif"],
      ["c.webp", Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([100, 0, 0, 0]), Buffer.from("WEBPVP8 ", "latin1")]), "image/webp"],
    ];
    for (const [name, bytes, mime] of cases) {
      await fs.writeFile(path.join(dir, name), bytes);
      const r = await read(dir, name);
      assert.equal(r.ok, true, `${name} must be readable`);
      assert.ok(r.image?.url.startsWith(`data:${mime};base64,`), `${name} → ${mime}, got ${r.image?.url.slice(0, 30)}`);
    }
  });
});

test("text is still text, and carries no image (#images)", async () => {
  await useTempDir("imgread3-", async (dir) => {
    await fs.writeFile(path.join(dir, "n.txt"), "hello\nworld\n");
    const r = await read(dir, "n.txt");
    assert.equal(r.ok, true);
    assert.equal(r.image, undefined, "a text file must not grow a phantom attachment");
    assert.match(r.result, /hello/);
  });
});

test("a real binary is still REFUSED — that was the original bug (#images)", async () => {
  await useTempDir("imgread4-", async (dir) => {
    // NUL bytes but no image signature: returning this as text is the mangled output d907af3 fixed
    await fs.writeFile(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
    const r = await read(dir, "blob.bin");
    assert.equal(r.ok, false, "refusing is the point — utf8 decode would mangle it");
    assert.equal(r.image, undefined);
    assert.match(r.result, /not text/);
    assert.match(r.result, /xxd/, "and it names an escape hatch");
  });
});
