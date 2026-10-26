import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { storeImage, resolveImage, resolveImages } from "../src/log/image-store.ts";
import { useTempDir } from "./helpers/tmp.ts";

/**
 * Image bytes live in the SESSION's own `blobs/`, and the log holds only a reference.
 *
 * The operator's requirement is the reason this exists: a session whose log grew huge must be
 * deletable in one `rm -r`, and its images must go with it. A shared store would leave orphans no
 * session owns, which is how "safe to delete" stops being true.
 *
 * The other half is that `chat.jsonl` stays text: MEASURED on the tool path, a single JPEG made a
 * 771KB line; with `blobs/` the same row is 505 bytes and contains no base64.
 */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753" +
    "de0000000c4944415408d763f8cfc0000003010100" +
    "18dd8db00000000049454e44ae426082",
  "hex",
);
const asDataUrl = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;

test("an image becomes a hashed file inside the session, and the log gets a reference (#blobs)", async () => {
  await useTempDir("blobs-", async (sessionDir) => {
    const dir = path.join(sessionDir, "blobs");
    const { ref, bytes } = await storeImage(dir, asDataUrl(PNG));
    assert.match(ref, /^blobs\/[a-f0-9]{64}\.png$/, "content hash, not a random name");
    assert.equal(bytes, PNG.length);
    const onDisk = await fs.readFile(path.join(sessionDir, ref));
    assert.deepEqual(onDisk, PNG, "the bytes written are the original bytes");
    assert.equal(asDataUrl(PNG).includes("base64"), true, "and the reference is far shorter than the data URL");
    assert.ok(ref.length < 100, `ref is ${ref.length} chars vs ${asDataUrl(PNG).length} for inline`);
  });
});

test("the same image stored twice costs one file (#blobs)", async () => {
  await useTempDir("blobs2-", async (sessionDir) => {
    const dir = path.join(sessionDir, "blobs");
    const a = await storeImage(dir, asDataUrl(PNG));
    const b = await storeImage(dir, asDataUrl(PNG));
    assert.equal(a.ref, b.ref, "content-addressed, so a re-read is idempotent");
    assert.equal((await fs.readdir(dir)).length, 1);
  });
});

test("a reference resolves back to bytes the model can take (#blobs)", async () => {
  await useTempDir("blobs3-", async (sessionDir) => {
    const dir = path.join(sessionDir, "blobs");
    const { ref } = await storeImage(dir, asDataUrl(PNG));
    const url = await resolveImage(dir, ref);
    assert.equal(url, asDataUrl(PNG), "round-trips exactly, so a restore sends what the live turn sent");
  });
});

test("a missing blob is DROPPED, never faked (#blobs)", async () => {
  await useTempDir("blobs4-", async (sessionDir) => {
    const dir = path.join(sessionDir, "blobs");
    const { ref } = await storeImage(dir, asDataUrl(PNG));
    await fs.rm(path.join(sessionDir, ref));
    assert.equal(await resolveImage(dir, ref), null, "an unreadable reference is null");
    assert.deepEqual(await resolveImages(dir, [ref]), [], "and contributes no part to the request");
  });
});

test("a path that climbs out of the session is refused (#blobs)", async () => {
  /**
   * The decoy lives INSIDE the managed root.
   *
   * It used to be written to `sessionDir/..`, i.e. one level above the directory `useTempDir()` owns
   * and cleans — so every run left `/tmp/teapot-tests/secret.png` behind. A test that proves "we cannot
   * read outside" must not itself write outside.
   *
   * `blobs/../secret.png` still escapes the blobs dir (the thing under test), while `../secret.png`
   * relative to the sandbox stays inside what the helper deletes.
   */
  await useTempDir("blobs5-", async (root) => {
    const sessionDir = path.join(root, "session");
    const dir = path.join(sessionDir, "blobs");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "secret.png"), PNG);
    assert.equal(await resolveImage(dir, "blobs/../secret.png"), null, "a sibling of blobs/ is not a blob");
    assert.equal(await resolveImage(dir, "blobs/../../etc/passwd"), null, "and neither is anything further out");
    // a value WITHOUT the prefix is not ours to resolve — it is returned as-is (an http/data URL case)
    assert.equal(await resolveImage(dir, "../secret.png"), "../secret.png");
  });
});

test("a remote or older inline URL passes through unchanged (#blobs)", async () => {
  await useTempDir("blobs6-", async (sessionDir) => {
    const dir = path.join(sessionDir, "blobs");
    assert.equal(await resolveImage(dir, "https://x/y.png"), "https://x/y.png", "not ours to copy");
    const inline = asDataUrl(PNG);
    assert.equal(await resolveImage(dir, inline), inline, "an old session keeps working");
  });
});
