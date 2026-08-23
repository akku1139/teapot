import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeTool, type ToolContext } from "../src/agent/tools.ts";

async function tmpCtx(): Promise<ToolContext> {
  const dir = await mkdtemp(path.join(tmpdir(), "teapot-tools-"));
  return {
    cwd: dir,
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 10_000,
    skillRoots: [
      { dir: path.join(dir, "skills"), source: "workspace" },
      { dir: path.join(dir, "global-skills"), source: "global" },
    ],
  };
}

test("write/read/edit roundtrip with offset+limit", async (t) => {
  const ctx = await tmpCtx();
  const w = await executeTool("write_file", JSON.stringify({ path: "a/b.txt", content: "l1\nl2\nl3\n" }), ctx);
  assert.ok(w.ok, w.result);

  const r = await executeTool("read_file", JSON.stringify({ path: "a/b.txt", offset: 2, limit: 1 }), ctx);
  assert.match(r.result, /^2\| l2\n\.\.\. \(\d+ more lines\)$/);

  const e = await executeTool(
    "edit_file",
    JSON.stringify({ path: "a/b.txt", old_text: "l2", new_text: "L2!" }),
    ctx,
  );
  assert.ok(e.ok);
  assert.equal(await readFile(path.join(ctx.cwd, "a/b.txt"), "utf8"), "l1\nL2!\nl3\n");
});

test("edit_file rejects missing and non-unique matches", async () => {
  const ctx = await tmpCtx();
  await executeTool("write_file", JSON.stringify({ path: "f.txt", content: "x x" }), ctx);
  const miss = await executeTool("edit_file", JSON.stringify({ path: "f.txt", old_text: "y", new_text: "z" }), ctx);
  assert.equal(miss.ok, false);
  const multi = await executeTool("edit_file", JSON.stringify({ path: "f.txt", old_text: "x", new_text: "z" }), ctx);
  assert.equal(multi.ok, false);
});

test("paths escaping the workspace are rejected", async () => {
  const ctx = await tmpCtx();
  const esc = await executeTool("write_file", JSON.stringify({ path: "../evil.txt", content: "no" }), ctx);
  assert.equal(esc.ok, false);
  assert.match(esc.result, /escapes workspace/);
});

test("bash captures stdout and reports failures", async () => {
  const ctx = await tmpCtx();
  const ok = await executeTool("bash", JSON.stringify({ command: "echo hi" }), ctx);
  assert.equal(ok.result.trim(), "hi");
  const fail = await executeTool("bash", JSON.stringify({ command: "exit 3" }), ctx);
  assert.equal(fail.ok, false);
  assert.match(fail.result, /exit=3/);
});

test("bash timeout kills the whole process group", async () => {
  const ctx = await tmpCtx();
  const t0 = Date.now();
  const r = await executeTool(
    "bash",
    JSON.stringify({ command: "sleep 30 & sleep 30", timeout_ms: 300 }),
    ctx,
  );
  assert.equal(r.ok, false);
  assert.match(r.result, /TIMEOUT/);
  assert.ok(Date.now() - t0 < 5_000);
});

test("aborting the context signal kills the whole process group quickly", async () => {
  const ctx = await tmpCtx();
  const ac = new AbortController();
  ctx.signal = ac.signal;
  const t0 = Date.now();
  const p = executeTool("bash", JSON.stringify({ command: "sleep 30 & sleep 30" }), ctx);
  setTimeout(() => ac.abort(), 150);
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.result, /ABORTED/);
  assert.ok(Date.now() - t0 < 5_000);
});

test("a command started after the abort is rejected immediately", async () => {
  const ctx = await tmpCtx();
  const ac = new AbortController();
  ctx.signal = ac.signal;
  ac.abort();
  const r = await executeTool("bash", JSON.stringify({ command: "echo hi" }), ctx);
  assert.equal(r.ok, false);
  assert.match(r.result, /aborted/);
});

test("edit_file tolerates LF patterns against CRLF files", async () => {
  const ctx = await tmpCtx();
  await executeTool("write_file", JSON.stringify({ path: "crlf.txt", content: "line1\r\nline2\r\n" }), ctx);
  const e = await executeTool(
    "edit_file",
    JSON.stringify({ path: "crlf.txt", old_text: "line1\nline2", new_text: "one\ntwo" }),
    ctx,
  );
  assert.ok(e.ok, e.result);
  assert.match(e.result, /CRLF→LF/);
  const r = await executeTool("read_file", JSON.stringify({ path: "crlf.txt" }), ctx);
  assert.match(r.result, /1\| one\n2\| two/);
});

test("unknown tool and invalid JSON args", async () => {
  const ctx = await tmpCtx();
  assert.equal((await executeTool("nope", "{}", ctx)).ok, false);
  assert.equal((await executeTool("read_file", "{bad json", ctx)).ok, false);
});

/* ---------- read_file: grep mode + negative offset ---------- */

async function seedLines(ctx: ToolContext, name = "lines.txt"): Promise<void> {
  await executeTool(
    "write_file",
    JSON.stringify({ path: name, content: "alpha\nbeta\ngamma\ndelta\nepsilon\n" }),
    ctx,
  );
}

test("read_file pattern mode returns matches with context and totals", async () => {
  const ctx = await tmpCtx();
  await seedLines(ctx);
  const r = await executeTool("read_file", JSON.stringify({ path: "lines.txt", pattern: "^a", context: 1 }), ctx);
  assert.ok(r.ok, r.result);
  // only "alpha" starts with 'a'; one context line after it
  assert.equal(r.result.trim(), "1| alpha\n2| beta");

  const multi = await executeTool("read_file", JSON.stringify({ path: "lines.txt", pattern: "^g|^e" }), ctx);
  assert.ok(multi.ok);
  // gamma(3) and epsilon(5) are disjoint regions → separated by "--"
  assert.match(multi.result, /3\| gamma\n--\n5\| epsilon/);
});

test("read_file pattern pagination and negative offset", async () => {
  const ctx = await tmpCtx();
  await seedLines(ctx);
  const p1 = await executeTool("read_file", JSON.stringify({ path: "lines.txt", pattern: "a", limit: 2 }), ctx);
  assert.match(p1.result, /\(1–2 of 4 matches\)/);

  const tail = await executeTool("read_file", JSON.stringify({ path: "lines.txt", offset: -3 }), ctx);
  assert.match(tail.result, /4\| delta/);
  assert.match(tail.result, /5\| epsilon/);
  assert.ok(!tail.result.includes("alpha"));

  const noMatch = await executeTool("read_file", JSON.stringify({ path: "lines.txt", pattern: "zzz" }), ctx);
  assert.ok(noMatch.ok);
  assert.match(noMatch.result, /no matches/);

  const badRe = await executeTool("read_file", JSON.stringify({ path: "lines.txt", pattern: "(unclosed" }), ctx);
  assert.equal(badRe.ok, false);
  assert.match(badRe.result, /invalid regex/);
});

/* ---------- edit_file: replace_all + recovery hints ---------- */

test("edit_file replace_all rewrites every occurrence", async () => {
  const ctx = await tmpCtx();
  await executeTool("write_file", JSON.stringify({ path: "r.txt", content: "x=1\nx=2\n" }), ctx);
  const r = await executeTool(
    "edit_file",
    JSON.stringify({ path: "r.txt", old_text: "x=", new_text: "y=", replace_all: true }),
    ctx,
  );
  assert.ok(r.ok, r.result);
  assert.match(r.result, /\(2 occurrences\)/);
  const read = await executeTool("read_file", JSON.stringify({ path: "r.txt" }), ctx);
  assert.match(read.result, /1\| y=1\n2\| y=2/);
});

test("edit_file falls back to trailing-whitespace matching and reports it", async () => {
  const ctx = await tmpCtx();
  await executeTool("write_file", JSON.stringify({ path: "ws.txt", content: "foo   \nbar\n" }), ctx);
  const r = await executeTool(
    "edit_file",
    JSON.stringify({ path: "ws.txt", old_text: "foo\nbar", new_text: "baz\nqux" }),
    ctx,
  );
  assert.ok(r.ok, r.result);
  assert.match(r.result, /trailing whitespace/);
  const read = await executeTool("read_file", JSON.stringify({ path: "ws.txt" }), ctx);
  assert.match(read.result, /1\| baz\n2\| qux/);
});

test("edit_file errors point at the fix (match lines / re-read hint)", async () => {
  const ctx = await tmpCtx();
  await executeTool("write_file", JSON.stringify({ path: "d.txt", content: "dup\nmid\ndup\n" }), ctx);
  const multi = await executeTool(
    "edit_file",
    JSON.stringify({ path: "d.txt", old_text: "dup", new_text: "?" }),
    ctx,
  );
  assert.equal(multi.ok, false);
  assert.match(multi.result, /matched 2 times \(lines 1, 3\)/);
  assert.match(multi.result, /replace_all=true/);

  const miss = await executeTool(
    "edit_file",
    JSON.stringify({ path: "d.txt", old_text: "totally absent text", new_text: "?" }),
    ctx,
  );
  assert.equal(miss.ok, false);
  assert.match(miss.result, /re-read d\.txt/);
});

/* ---------- apply_patch ---------- */

const PATCH_MULTI = `*** Begin Patch
*** Add File: pa/new.txt
+hello
+world
*** Update File: pa/existing.txt
@@ head
-old one
-new two
+first line
+second line
*** Delete File: pa/gone.txt
*** End Patch`;

test("apply_patch adds, updates and deletes several files atomically", async () => {
  const ctx = await tmpCtx();
  await executeTool("write_file", JSON.stringify({ path: "pa/existing.txt", content: "head\nold one\nnew two\ntail\n" }), ctx);
  await executeTool("write_file", JSON.stringify({ path: "pa/gone.txt", content: "bye\n" }), ctx);

  const r = await executeTool("apply_patch", JSON.stringify({ patch: PATCH_MULTI }), ctx);
  assert.ok(r.ok, r.result);
  assert.match(r.result, /A pa\/new\.txt/);
  assert.match(r.result, /U pa\/existing\.txt/);
  assert.match(r.result, /D pa\/gone\.txt/);

  assert.equal(await readFile(path.join(ctx.cwd, "pa/new.txt"), "utf8"), "hello\nworld\n");
  assert.equal(
    await readFile(path.join(ctx.cwd, "pa/existing.txt"), "utf8"),
    "head\nfirst line\nsecond line\ntail\n",
  );
  assert.equal(existsSync(path.join(ctx.cwd, "pa/gone.txt")), false);
});

test("apply_patch is all-or-nothing on failure", async () => {
  const ctx = await tmpCtx();
  const good = "untouched\n";
  await executeTool("write_file", JSON.stringify({ path: "keep.txt", content: good }), ctx);
  const patch = `*** Begin Patch
*** Update File: keep.txt
@@
-untouched
+changed
*** Update File: missing.txt
@@
-nope
+nope
*** End Patch`;
  const r = await executeTool("apply_patch", JSON.stringify({ patch }), ctx);
  assert.equal(r.ok, false);
  assert.match(r.result, /missing\.txt/);
  assert.equal(await readFile(path.join(ctx.cwd, "keep.txt"), "utf8"), good); // rolled back = never written
});

test("apply_patch supports rename, EOF append and whitespace tolerance", async () => {
  const ctx = await tmpCtx();
  await executeTool("write_file", JSON.stringify({ path: "old-name.ts", content: "one\ntwo\n" }), ctx);

  const rename = `*** Begin Patch
*** Update File: old-name.ts
*** Move to: new-name.ts
@@
-one
+ONE
*** End Patch`;
  const r = await executeTool("apply_patch", JSON.stringify({ patch: rename }), ctx);
  assert.ok(r.ok, r.result);
  assert.equal(existsSync(path.join(ctx.cwd, "old-name.ts")), false);
  assert.match(await readFile(path.join(ctx.cwd, "new-name.ts"), "utf8"), /ONE\ntwo/);

  const append = `*** Begin Patch
*** Update File: new-name.ts
@@
+three
*** End Patch`;
  const r2 = await executeTool("apply_patch", JSON.stringify({ patch: append }), ctx);
  assert.ok(r2.ok, r2.result);
  assert.equal(await readFile(path.join(ctx.cwd, "new-name.ts"), "utf8"), "ONE\ntwo\nthree\n");

  // trailing-whitespace mismatch still applies (codex seek_sequence fallbacks)
  await executeTool("write_file", JSON.stringify({ path: "wsy.txt", content: "foo   \nbar\n" }), ctx);
  const wsPatch = `*** Begin Patch
*** Update File: wsy.txt
@@
-foo
-bar
+baz
*** End Patch`;
  const r3 = await executeTool("apply_patch", JSON.stringify({ patch: wsPatch }), ctx);
  assert.ok(r3.ok, r3.result);
  assert.equal(await readFile(path.join(ctx.cwd, "wsy.txt"), "utf8"), "baz\n");

  // malformed patches are rejected with actionable messages
  const bad = await executeTool("apply_patch", JSON.stringify({ patch: "*** Begin Patch\\nnope\\n*** End Patch" }), ctx);
  assert.equal(bad.ok, false);
});

/* ---------- skills with bundled scripts ---------- */

test("load_skill surfaces bundled scripts as runnable paths", async () => {
  const ctx = await tmpCtx();
  await mkdir(path.join(ctx.cwd, "skills", "deploy"), { recursive: true });
  await executeTool(
    "write_file",
    JSON.stringify({
      path: "skills/deploy/SKILL.md",
      content: "---\nname: deploy\ndescription: ship it\n---\n1. build\n2. run ./rollback.sh on failure",
    }),
    ctx,
  );
  await executeTool(
    "write_file",
    JSON.stringify({ path: "skills/deploy/rollback.sh", content: "#!/bin/sh\necho rolling back\n" }),
    ctx,
  );

  const r = await executeTool("load_skill", JSON.stringify({ name: "deploy" }), ctx);
  assert.ok(r.ok, r.result);
  assert.match(r.result, /run \.\/rollback\.sh on failure/); // SKILL.md body
  assert.match(r.result, /Files bundled with this skill:/);
  assert.match(r.result, /skills\/deploy\/rollback\.sh/); // runnable, workspace-relative
});

/* ---------- read_url ---------- */

test("read_url extracts readable text from a local page (and caches it)", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      "<html><body><nav>menu noise</nav><article><h1>Teapot Docs</h1>" +
        "<p>Brewing instructions here.</p></article></body></html>",
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const ctx = await tmpCtx();
    const bad = await executeTool("read_url", JSON.stringify({ url: "notaurl" }), ctx);
    assert.equal(bad.ok, false);

    const r = await executeTool("read_url", JSON.stringify({ url: `http://127.0.0.1:${port}/docs` }), ctx);
    assert.ok(r.ok, r.result);
    assert.match(r.result, /Teapot Docs/);
    assert.match(r.result, /Brewing instructions here\./);

    // second call is served from cache (server may be dead by then — still works)
    await new Promise<void>((r2) => server.close(() => r2()));
    const cached = await executeTool("read_url", JSON.stringify({ url: `http://127.0.0.1:${port}/docs` }), ctx);
    assert.ok(cached.ok, cached.result);
    assert.match(cached.result, /Brewing instructions here\./);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
