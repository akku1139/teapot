import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
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
