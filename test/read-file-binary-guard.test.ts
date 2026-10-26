import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { looksBinary } from "../src/agent/tools.ts";

/**
 * `read_file` must refuse BINARY content, not decode it.
 *
 * Reported as "画像をread_fileしてバイナリが帰ってきてる". `readText` does `fs.readFile(p, "utf8")`
 * with no encoding check, so an image came back as a lossy string: the model paid for mojibake it
 * cannot interpret and could not tell "this is data" from "this is source".
 *
 * MEASURED against real headers: a NUL-byte scan alone missed PDF and zip (their first bytes contain
 * no zero), which is why magic-byte detection runs FIRST and the NUL test is the fallback.
 */
const dir = mkdtempInRootSync("binary-guard-");
const mk = (name: string, content: Buffer | string): string => {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
};

test("text files are readable, including non-ASCII (#read_file)", async () => {
  for (const [name, body] of [
    ["a.ts", "export const x = 1;\n"],
    ["jp.md", "日本語のテキスト\n"],
    ["html.js", "// <div> angle brackets are text\n"],
    ["empty.txt", ""],
  ] as const) {
    const r = await looksBinary(mk(name, body));
    assert.equal(r.binary, false, `${name} must be read as text (got ${r.kind})`);
  }
});

test("images, archives and executables are refused, with the type named (#read_file)", async () => {
  const png = await looksBinary(
    mk("i.png", Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("0000000d49484452", "hex"), Buffer.alloc(16)])),
  );
  assert.equal(png.binary, true);
  assert.equal(png.kind, "PNG image", "the message must say WHAT it is, so the model can choose another tool");

  assert.equal((await looksBinary(mk("i.jpg", Buffer.from("ffd8ffe000104a464946", "hex")))).kind, "JPEG image");
  assert.equal((await looksBinary(mk("a.zip", Buffer.from("504b0304", "hex")))).kind, "zip archive");
  assert.equal((await looksBinary(mk("e.elf", Buffer.from("7f454c4602010100", "hex")))).kind, "ELF binary");
  assert.equal((await looksBinary(mk("g.gz", Buffer.from("1f8b08", "hex")))).kind, "gzip archive");
});

test("a PDF is binary even though its header has no NUL byte (#read_file)", async () => {
  /**
   * The measured hole in a NUL-only test: `%PDF-1.7` is all printable bytes, so the first version of
   * this guard reported "text" and would have shipped a silent regression.
   */
  const r = await looksBinary(mk("d.pdf", Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", "latin1")));
  assert.equal(r.binary, true, "PDF must be refused");
  assert.equal(r.kind, "PDF");
});

test("an unrecognised file with a NUL byte is still refused (#read_file)", async () => {
  const r = await looksBinary(mk("x.bin", Buffer.from([1, 2, 0, 4])));
  assert.equal(r.binary, true, "the NUL fallback covers formats with no known signature");
  assert.equal(r.kind, "binary");
});
