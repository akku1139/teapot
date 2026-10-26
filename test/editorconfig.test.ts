import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { executeTool, type ToolContext } from "../src/agent/tools.ts";
import { editorConfigFor, sectionMatches } from "../src/agent/editorconfig.ts";

const ctxOf = (cwd: string): ToolContext =>
  ({ cwd, defaultTimeoutMs: 5_000, maxOutputBytes: 100_000 }) as unknown as ToolContext;

const write = (cwd: string, args: Record<string, unknown>) =>
  executeTool("write_file", JSON.stringify(args), ctxOf(cwd));

test("a NEW file takes its line ending from .editorconfig (#109)", async () => {
  const ws = mkdtempInRootSync("ec-new-");
  fs.writeFileSync(path.join(ws, ".editorconfig"), "root = true\n\n[*]\nend_of_line = crlf\n");
  const r = await write(ws, { path: "new.txt", content: "a\nb\n" });
  assert.equal(r.ok, true);
  assert.equal(
    fs.readFileSync(path.join(ws, "new.txt"), "utf8"),
    "a\r\nb\r\n",
    "a new file must use the configured ending, not the LF default",
  );
  assert.match(r.result, /CRLF/, "and it must SAY so — a silent conversion is what #84 was about");
});

test("an EXISTING file's own ending OUTRANKS .editorconfig (#109/#84)", async () => {
  const ws = mkdtempInRootSync("ec-exist-");
  fs.writeFileSync(path.join(ws, ".editorconfig"), "root = true\n\n[*]\nend_of_line = crlf\n");
  fs.writeFileSync(path.join(ws, "lf.txt"), "x\ny\n");
  const r = await write(ws, { path: "lf.txt", content: "p\nq\n" });
  assert.equal(r.ok, true);
  assert.equal(
    fs.readFileSync(path.join(ws, "lf.txt"), "utf8"),
    "p\nq\n",
    "the file's own bytes outrank the config, or every LF repo with a CRLF setting churns",
  );
});

test("a .editorconfig section only applies to the files it names (#109)", async () => {
  const ws = mkdtempInRootSync("ec-glob-");
  fs.writeFileSync(
    path.join(ws, ".editorconfig"),
    "root = true\n\n[*.md]\nend_of_line = crlf\n\n[scripts/**.js]\nend_of_line = cr\n",
  );
  await write(ws, { path: "readme.md", content: "a\nb\n" });
  await write(ws, { path: "code.ts", content: "a\nb\n" });
  await write(ws, { path: path.join("scripts", "deep", "run.js"), content: "a\nb\n" });
  assert.equal(fs.readFileSync(path.join(ws, "readme.md"), "utf8"), "a\r\nb\r\n", "[*.md] applies");
  assert.equal(
    fs.readFileSync(path.join(ws, "code.ts"), "utf8"),
    "a\nb\n",
    "a file the config does not name keeps the default",
  );
  assert.equal(
    fs.readFileSync(path.join(ws, "scripts", "deep", "run.js"), "utf8"),
    "a\rb\r",
    "[scripts/**.js] must reach a nested path",
  );
});

test("insert_final_newline = true ends a new file with a newline (#109)", async () => {
  const ws = mkdtempInRootSync("ec-fnl-");
  fs.writeFileSync(path.join(ws, ".editorconfig"), "root = true\n\n[*]\ninsert_final_newline = true\n");
  await write(ws, { path: "n.txt", content: "no trailing newline" });
  assert.equal(fs.readFileSync(path.join(ws, "n.txt"), "utf8"), "no trailing newline\n");
});

test("a nested .editorconfig overrides the root one, and root=true stops the walk (#109)", async () => {
  const ws = mkdtempInRootSync("ec-nest-");
  fs.writeFileSync(path.join(ws, ".editorconfig"), "root = true\n\n[*]\nend_of_line = crlf\n");
  const sub = path.join(ws, "sub");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, ".editorconfig"), "[*]\nend_of_line = lf\n");
  await write(sub, { path: "a.txt", content: "a\nb\n" });
  assert.equal(
    fs.readFileSync(path.join(sub, "a.txt"), "utf8"),
    "a\nb\n",
    "the NEAREST .editorconfig must win",
  );
});

test("no .editorconfig leaves the LF default untouched (#109)", async () => {
  const ws = mkdtempInRootSync("ec-none-");
  await write(ws, { path: "plain.txt", content: "a\nb\n" });
  assert.equal(fs.readFileSync(path.join(ws, "plain.txt"), "utf8"), "a\nb\n");
});

test("the config reader reports nothing rather than guessing (#109)", () => {
  const ws = mkdtempInRootSync("ec-read-");
  assert.deepEqual(editorConfigFor(path.join(ws, "x.txt")), { eol: null }, "no file -> no opinion");
  fs.writeFileSync(path.join(ws, ".editorconfig"), "end_of_line = crlf\n");
  assert.deepEqual(editorConfigFor(path.join(ws, "x.txt")), { eol: null });
  fs.writeFileSync(path.join(ws, ".editorconfig"), "[*]\nend_of_line = wat\n");
  assert.deepEqual(editorConfigFor(path.join(ws, "x.txt")), { eol: null });
});

test("editorconfig globs match the way the format documents (#109)", () => {
  assert.equal(sectionMatches("*.md", "docs/x.md"), true);
  assert.equal(sectionMatches("*.md", "x.txt"), false);
  assert.equal(sectionMatches("src/*.ts", "src/a.ts"), true);
  assert.equal(sectionMatches("src/*.ts", "src/sub/a.ts"), false);
  assert.equal(sectionMatches("src/**.ts", "src/sub/a.ts"), true);
  assert.equal(sectionMatches("**/*.ts", "a.ts"), true, "**/ must also match zero segments");
  assert.equal(sectionMatches("**.{js,ts}", "x/y/a.ts"), true);
  assert.equal(sectionMatches("**.{js,ts}", "x/y/a.py"), false);
  assert.equal(sectionMatches("lib/[ab].js", "lib/a.js"), true);
  assert.equal(sectionMatches("lib/[ab].js", "lib/c.js"), false);
});
