import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, chmod, writeFile as fsWrite, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { executeTool, type ToolContext } from "../src/agent/tools.ts";
import { useTempDir } from "./helpers/tmp.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// #110: POSIX-only — runs POSIX commands through the bash tool; POSIX file modes.
// The Windows CI job skips this file; see test/helpers/posix-only.ts for why
// opting out is explicit rather than by filename.
markPosixOnly("runs POSIX commands through the bash tool; POSIX file modes");

async function withCtx(fn: (ctx: ToolContext) => Promise<void>): Promise<void> {
  await useTempDir("teapot-tools-", async (dir) => {
    await fn({
      cwd: dir,
      defaultTimeoutMs: 5_000,
      maxOutputBytes: 10_000,
      skillRoots: [
        { dir: path.join(dir, "skills"), source: "workspace" },
        { dir: path.join(dir, "global-skills"), source: "global" },
      ],
    });
  });
}

test("write/read/edit roundtrip with offset+limit", async (_t) => {
  await withCtx(async (ctx) => {
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
});

test("edit_file rejects missing and non-unique matches", async () => {
  await withCtx(async (ctx) => {
    await executeTool("write_file", JSON.stringify({ path: "f.txt", content: "x x" }), ctx);
    const miss = await executeTool("edit_file", JSON.stringify({ path: "f.txt", old_text: "y", new_text: "z" }), ctx);
    assert.equal(miss.ok, false);
    const multi = await executeTool("edit_file", JSON.stringify({ path: "f.txt", old_text: "x", new_text: "z" }), ctx);
    assert.equal(multi.ok, false);
  });
});

test("paths escaping the workspace are rejected", async () => {
  await withCtx(async (ctx) => {
    const esc = await executeTool("write_file", JSON.stringify({ path: "../evil.txt", content: "no" }), ctx);
    assert.equal(esc.ok, false);
    assert.match(esc.result, /escapes workspace/);
  });
});

test("bash captures stdout and reports failures", async () => {
  await withCtx(async (ctx) => {
    const ok = await executeTool("bash", JSON.stringify({ command: "echo hi" }), ctx);
    // stdout comes first; the trailing "[took Ns]" stamp (#26) rides along so
    // the MODEL sees the elapsed time, not just the operator in the UI
    assert.match(ok.result, /^hi\n\[took \d+\.\d+s\]$/);
    const fail = await executeTool("bash", JSON.stringify({ command: "exit 3" }), ctx);
    assert.equal(fail.ok, false);
    assert.match(fail.result, /exit=3/);
  });
});

test("bash timeout kills the whole process group", async () => {
  await withCtx(async (ctx) => {
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
});

test("aborting the context signal kills the whole process group quickly", async () => {
  await withCtx(async (ctx) => {
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
});

test("a command started after the abort is rejected immediately", async () => {
  await withCtx(async (ctx) => {
    const ac = new AbortController();
    ctx.signal = ac.signal;
    ac.abort();
    const r = await executeTool("bash", JSON.stringify({ command: "echo hi" }), ctx);
    assert.equal(r.ok, false);
    assert.match(r.result, /aborted/);
  });
});

test("edit_file tolerates LF patterns against CRLF files", async () => {
  await withCtx(async (ctx) => {
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
});

/* ---------- optimistic concurrency: don't clobber unseen edits (#5) ---------- */

test("edit_file refuses a stale edit when base_content no longer matches (#5)", async () => {
  await withCtx(async (ctx) => {
    const p = "race.txt";
    const v1 = "alpha\nbeta\n";
    await executeTool("write_file", JSON.stringify({ path: p, content: v1 }), ctx);

    // the model reads v1, then something else edits the file behind it
    const v2 = "alpha\nBETA\n";
    await fsWrite(path.join(ctx.cwd, p), v2);

    const r = await executeTool(
      "edit_file",
      JSON.stringify({ path: p, old_text: "beta", new_text: "gamma", base_content: v1 }),
      ctx,
    );
    assert.equal(r.ok, false, "a stale edit must be refused");
    assert.match(r.result, /changed on disk since you read it/);
    assert.match(r.result, /nothing was written/);
    // the concurrent edit survives untouched
    assert.equal(await readFile(path.join(ctx.cwd, p), "utf8"), v2);
  });
});

test("edit_file proceeds when base_content still matches (#5)", async () => {
  await withCtx(async (ctx) => {
    const p = "same.txt";
    const v1 = "alpha\nbeta\n";
    await executeTool("write_file", JSON.stringify({ path: p, content: v1 }), ctx);
    const r = await executeTool(
      "edit_file",
      JSON.stringify({ path: p, old_text: "beta", new_text: "gamma", base_content: v1 }),
      ctx,
    );
    assert.ok(r.ok, r.result);
    assert.equal(await readFile(path.join(ctx.cwd, p), "utf8"), "alpha\ngamma\n");
  });
});

test("replace_all cannot rewrite occurrences added after the model read (#5)", async () => {
  await withCtx(async (ctx) => {
    const p = "multi.txt";
    const v1 = "y=1\n"; // the model saw exactly ONE occurrence
    await executeTool("write_file", JSON.stringify({ path: p, content: v1 }), ctx);
    // a sub-agent appends two more occurrences
    const v2 = "y=1\ny=2\ny=3\n";
    await fsWrite(path.join(ctx.cwd, p), v2);

    const r = await executeTool(
      "edit_file",
      JSON.stringify({ path: p, old_text: "y=", new_text: "z=", replace_all: true, base_content: v1 }),
      ctx,
    );
    assert.equal(r.ok, false, "replace_all must not clobber unseen occurrences");
    assert.match(r.result, /changed on disk since you read it/);
    assert.equal(await readFile(path.join(ctx.cwd, p), "utf8"), v2);
  });
});

test("write_file refuses to overwrite a changed file (#5)", async () => {
  await withCtx(async (ctx) => {
    const p = "cfg.json";
    await executeTool("write_file", JSON.stringify({ path: p, content: '{"v":1}\n' }), ctx);
    const current = '{"v":1}\n';
    await fsWrite(path.join(ctx.cwd, p), '{"v":2}\n'); // edited behind the model

    const r = await executeTool(
      "write_file",
      JSON.stringify({ path: p, content: '{"v":0}\n', base_content: current }),
      ctx,
    );
    assert.equal(r.ok, false);
    assert.match(r.result, /changed on disk since you read it/);
    assert.equal(await readFile(path.join(ctx.cwd, p), "utf8"), '{"v":2}\n');
  });
});

test("base_content is OPTIONAL — behaviour is unchanged when omitted (#5)", async () => {
  await withCtx(async (ctx) => {
    await executeTool("write_file", JSON.stringify({ path: "opt.txt", content: "a\n" }), ctx);
    const e = await executeTool(
      "edit_file",
      JSON.stringify({ path: "opt.txt", old_text: "a", new_text: "b" }),
      ctx,
    );
    assert.ok(e.ok, e.result);
    assert.equal(await readFile(path.join(ctx.cwd, "opt.txt"), "utf8"), "b\n");
  });
});

test("base_content treats a deleted file as changed (#5)", async () => {
  await withCtx(async (ctx) => {
    const p = "gone.txt";
    await executeTool("write_file", JSON.stringify({ path: p, content: "x\n" }), ctx);
    await rm(path.join(ctx.cwd, p), { force: true });
    const r = await executeTool(
      "write_file",
      JSON.stringify({ path: p, content: "y\n", base_content: "x\n" }),
      ctx,
    );
    assert.equal(r.ok, false);
    assert.match(r.result, /deleted/);
  });
});

test("unknown tool and invalid JSON args", async () => {
  await withCtx(async (ctx) => {
    assert.equal((await executeTool("nope", "{}", ctx)).ok, false);
    assert.equal((await executeTool("read_file", "{bad json", ctx)).ok, false);
  });
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
  await withCtx(async (ctx) => {
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
});

test("read_file pattern pagination and negative offset", async () => {
  await withCtx(async (ctx) => {
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
});

/* ---------- edit_file: replace_all + recovery hints ---------- */

test("edit_file replace_all rewrites every occurrence", async () => {
  await withCtx(async (ctx) => {
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
});

test("edit_file falls back to trailing-whitespace matching and reports it", async () => {
  await withCtx(async (ctx) => {
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
});

test("edit_file errors point at the fix (match lines / re-read hint)", async () => {
  await withCtx(async (ctx) => {
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
  await withCtx(async (ctx) => {
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
});

test("apply_patch is all-or-nothing on failure", async () => {
  await withCtx(async (ctx) => {
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
});

test("apply_patch rolls back writes when the COMMIT phase fails midway (#6)", async () => {
  // Phase 1 (validation) already passed for every hunk — this fails in phase 2
  // on an I/O error, which used to leave earlier writes on disk while the tool
  // reported failure. A read-only directory makes the second write EACCES.
  await withCtx(async (ctx) => {
    const f1 = "original one\n";
    await executeTool("write_file", JSON.stringify({ path: "a.txt", content: f1 }), ctx);
    const locked = path.join(ctx.cwd, "locked");
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o555); // r-x: cannot create files inside
    try {
      const patch = `*** Begin Patch
*** Update File: a.txt
@@
-original one
+CHANGED one
*** Add File: locked/new.txt
+nope
*** End Patch`;
      const r = await executeTool("apply_patch", JSON.stringify({ patch }), ctx);
      assert.equal(r.ok, false, `expected commit failure, got: ${r.result}`);
      assert.match(r.result, /rolled back/);

      // the first write must be UNDONE, not left applied
      assert.equal(await readFile(path.join(ctx.cwd, "a.txt"), "utf8"), f1);
      assert.equal(existsSync(path.join(locked, "new.txt")), false);
      // and no temp litter anywhere in the workspace
      const stray = readdirSync(ctx.cwd, { recursive: true }).filter((f) => String(f).includes(".teapot-patch-"));
      assert.deepEqual(stray, [], `temp files leaked: ${stray.join(", ")}`);
    } finally {
      await chmod(locked, 0o755); // let the temp-dir cleanup remove it
    }
  });
});

test("apply_patch leaves no temp files on success", async () => {
  await withCtx(async (ctx) => {
    await executeTool("write_file", JSON.stringify({ path: "b.txt", content: "x\n" }), ctx);
    const r = await executeTool(
      "apply_patch",
      JSON.stringify({
        patch: `*** Begin Patch
*** Update File: b.txt
@@
-x
+y
*** End Patch`,
      }),
      ctx,
    );
    assert.ok(r.ok, r.result);
    assert.equal(await readFile(path.join(ctx.cwd, "b.txt"), "utf8"), "y\n");
    const stray = readdirSync(ctx.cwd, { recursive: true }).filter((f) => String(f).includes(".teapot-patch-"));
    assert.deepEqual(stray, []);
  });
});

test("apply_patch supports rename, EOF append and whitespace tolerance", async () => {
  await withCtx(async (ctx) => {
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
});

/* ---------- skills with bundled scripts ---------- */

test("load_skill surfaces bundled scripts as runnable paths", async () => {
  await withCtx(async (ctx) => {
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
    await withCtx(async (ctx) => {
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
    });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("apply_patch rejects \u0000-mangled patches with actionable guidance", async () => {
  await useTempDir("ap-", async (cwd) => {
    const ctx: ToolContext = {
      cwd,
      defaultTimeoutMs: 5_000,
      maxOutputBytes: 10_000,
    };
    // real-world failure (study-blog session): the model's LaTeX backslashes
    // arrived as "\u0000" — applying verbatim writes broken source and the
    // repair attempts then corrupted unrelated lines
    const patch =
      '*** Begin Patch\n*** Add File: t.ts\n+x = "$\\u0000sqrt{12}$";\n*** End Patch';
    const r = await executeTool("apply_patch", JSON.stringify({ patch }), ctx);
    assert.equal(r.ok, false);
    assert.match(r.result, /\\u0000/);
    assert.match(r.result, /re-emit/); // tells the model what to do instead
    // nothing was written
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(`${ctx.cwd}/t.ts`));
  });
});

test("save_skill bundles helper scripts next to SKILL.md (regression)", async () => {
  await useTempDir("sk-bundle-", async (cwd) => {
    const ctx: ToolContext = {
      cwd,
      defaultTimeoutMs: 5_000,
      maxOutputBytes: 10_000,
      skillRoots: [{ dir: path.join(cwd, "skills"), source: "global" }],
    };
    const r = await executeTool(
      "save_skill",
      JSON.stringify({
        name: "helper-check",
        description: "bundled files regression",
        content: "# body",
        files: [
          { name: "tool.py", content: "print('hi')" },
          { name: "../escape.sh", content: "nope" }, // must be skipped
        ],
      }),
      ctx,
    );
    assert.equal(r.ok, true);
    assert.match(r.result, /tool\.py/);
    // helper exists, is executable, and the traversal attempt never landed
    const { stat } = await import("node:fs/promises");
    const st = await stat(path.join(ctx.skillRoots[0]!.dir, "helper-check", "tool.py"));
    assert.equal(st.mode & 0o111 ? true : false, true); // executable bit set
    await assert.rejects(stat(path.join(ctx.skillRoots[0]!.dir, "escape.sh")));
  });
});

/* ---------- background shells: exit vs close (#23) ---------- */

test("a background shell that forks an inheriting child still reports its exit (#23)", async () => {
  await withCtx(async (ctx) => {
    const exits: { id: string; code: number | null; cmd: string }[] = [];
    ctx.onBackgroundExit = (i) => exits.push({ id: i.id, code: i.code, cmd: i.cmd });

    // the shell exits IMMEDIATELY, but the backgrounded grandchild inherits
    // stdout, so Node's "close" event (stdio drained) never fires. Keying exit
    // state off "close" left the job marked running forever, which pinned the
    // agent in "running" and suppressed auto-continue.
    const r = await executeTool(
      "bash",
      JSON.stringify({ command: "sleep 3 & echo started", background: true }),
      ctx,
    );
    assert.ok(r.ok, r.result);
    const jobId = /bg\d+/.exec(r.result)?.[0];
    assert.ok(jobId, `expected a bg id in: ${r.result}`);

    // the shell is gone within a second even though "close" is still pending
    const t0 = Date.now();
    for (;;) {
      if (exits.length) break;
      assert.ok(Date.now() - t0 < 2500, "exit notification never arrived");
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(exits.length, 1, "exactly one exit notification");
    assert.equal(exits[0].code, 0);
    assert.match(exits[0].cmd, /sleep 3/);

    // and it must no longer count as a running background shell, or the
    // auto-continue loop would suppress its nudge forever
    const { hasRunningBgShells } = await import("../src/agent/tools.ts");
    assert.equal(hasRunningBgShells(ctx.cwd), false, "a dead shell must not look alive");
  });
});

test("a normally-exiting background shell still notifies exactly once (#23)", async () => {
  await withCtx(async (ctx) => {
    const exits: number[] = [];
    ctx.onBackgroundExit = (i) => exits.push(i.code ?? -1);
    const r = await executeTool(
      "bash",
      JSON.stringify({ command: "echo hi", background: true }),
      ctx,
    );
    assert.ok(r.ok, r.result);
    const t0 = Date.now();
    while (!exits.length) {
      assert.ok(Date.now() - t0 < 2500, "exit notification never arrived");
      await new Promise((r) => setTimeout(r, 25));
    }
    // exit AND close both fire here — the notification must not double up
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(exits, [0], "exactly one notification, with the real code");
  });
});
