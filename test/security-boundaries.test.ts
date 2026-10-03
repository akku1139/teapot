/**
 * Workspace containment, from a full-codebase review.
 *
 * Two escapes, both found by probing rather than reading, and both in the
 * "defence" layer — the code whose only job is to refuse.
 *
 * #74 was reported as "create through a dangling symlink escapes the
 * workspace". **I could not reproduce it** — every variant is refused by the
 * code as shipped, and the tests below document the real invariant rather than
 * a bug. Kept here because the reasoning is easy to get wrong: `realpathSync`
 * failing does not mean "allow".
 *
 * #72 — agent ids become directory names, and every caller sanitised its own
 * except the ACP adapter, which passed the raw client string through:
 * `session/load {"sessionId":"../../escape"}` logged outside the sessions dir.
 * Fixed centrally in `addAgent` so the guarantee is structural.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink, access } from "node:fs/promises";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeTool, safeJoin } from "../src/agent/tools.ts";
import { sanitizeAgentId } from "../src/master.ts";

/* ---------- #74: workspace containment ---------- */

/*
 * The escape: `esc -> /outside` where /outside is a REAL directory.
 *
 * `safeJoin` resolved the target and swallowed the throw, treating failure as
 * "fine" — and the failure is the NORMAL case, because `realpathSync` throws
 * ENOENT for a file that does not exist yet, which is every write_file
 * creating something new. So `real` stayed as the LEXICAL path (inside the
 * workspace) and the symlink guard never ran.
 *
 * The dangling variant happened to fail later with ENOTDIR from mkdir, which is
 * luck, not a control — the escape only needs a target that exists.
 */

test("a write through a symlink to a real directory outside is refused (#74)", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "p74a-"));
  const outside = await mkdtemp(path.join(tmpdir(), "out74a-"));
  await symlink(outside, path.join(ws, "esc"), "dir");
  const r = await executeTool(
    "write_file",
    JSON.stringify({ path: "esc/pwned.txt", content: "PWNED" }),
    { cwd: ws, defaultTimeoutMs: 5000, maxOutputBytes: 10_000 } as never,
  );
  assert.equal(r.ok, false, `the write must be refused (#74); got ${r.result}`);
  await assert.rejects(
    access(path.join(outside, "pwned.txt")),
    "NOTHING MAY LAND OUTSIDE THE WORKSPACE (#74)",
  );
});

test("a nested path through such a symlink is refused too (#74)", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "p74b-"));
  const outside = await mkdtemp(path.join(tmpdir(), "out74b-"));
  await symlink(outside, path.join(ws, "esc"), "dir");
  const r = await executeTool(
    "write_file",
    JSON.stringify({ path: "esc/deep/nested/pwned.txt", content: "PWNED" }),
    { cwd: ws, defaultTimeoutMs: 5000, maxOutputBytes: 10_000 } as never,
  );
  assert.equal(r.ok, false, "nested writes through the symlink must be refused (#74)");
  await assert.rejects(access(path.join(outside, "deep", "nested", "pwned.txt")));
});

test("a symlink to a FILE outside is refused (#74)", () => {
  const ws = mkdtempSyncTmp();
  const outside = mkdtempSyncTmp();
  writeFileSync(path.join(outside, "secret.txt"), "s");
  symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "link.txt"), "file");
  assert.throws(() => safeJoin(ws, "link.txt"), /escapes workspace via symlink/);
});

test("a symlink to a NOT-YET-CREATED directory outside is refused (#74)", () => {
  // Previously allowed by safeJoin; it only failed later in mkdir, by luck.
  const ws = mkdtempSyncTmp();
  const outside = mkdtempSyncTmp();
  symlinkSync(path.join(outside, "future"), path.join(ws, "dangling"), "dir");
  assert.throws(() => safeJoin(ws, "dangling/y.txt"), /escapes workspace via symlink/);
});

test("legitimate writes still work (#74)", () => {
  // Not "refuse anything missing" — that would break every new file, which is
  // the tool's main job. These are the cases the ENOENT path must still allow.
  assert.doesNotThrow(() => safeJoin("/ws", "new-file.txt"));
  assert.doesNotThrow(() => safeJoin("/ws", "brand/new/dir/file.txt"));
  assert.doesNotThrow(() => safeJoin("/ws", "a/b/c/deep.txt"));
});

test("traversal is still refused lexically (#74)", () => {
  for (const p of ["../outside.txt", "../../etc/passwd", "/etc/passwd", "a/../../b"]) {
    assert.throws(() => safeJoin("/ws", p), /escapes workspace/, `${p} must be refused`);
  }
});

test("a symlink INSIDE the workspace still works (#74)", () => {
  // A symlink to a sibling directory within the workspace is legitimate and
  // must not be blocked by the fix.
  const ws = mkdtempSyncTmp();
  mkdirSync(path.join(ws, "real"), { recursive: true });
  symlinkSync(path.join(ws, "real"), path.join(ws, "link"), "dir");
  assert.doesNotThrow(() => safeJoin(ws, "link/file.txt"));
});

function mkdtempSyncTmp(): string {
  return mkdtempSync(path.join(tmpdir(), "s-"));
}

/* ---------- #72: agent ids ---------- */

test("a path-like agent id cannot escape the sessions dir (#72)", () => {
  for (const id of ["../../escape", "..", "a/b", "....//x", "/abs/path"]) {
    const safe = sanitizeAgentId(id);
    const resolved = path.resolve("/data/sessions", `${safe}-abc123`);
    assert.ok(
      resolved.startsWith("/data/sessions/"),
      `${JSON.stringify(id)} -> ${JSON.stringify(safe)} must stay inside the sessions dir (#72)`,
    );
  }
});

test("sanitising does not mangle a safe id (#72)", () => {
  for (const id of ["teapot", "teapot-8f2a1c", "proj_a.2", "a1"]) {
    assert.equal(sanitizeAgentId(id), id, `${id} is already safe and must be untouched`);
  }
});

test("an id that sanitises to nothing gets a usable fallback (#72)", () => {
  for (const id of ["", "..", "///", "..."]) {
    const safe = sanitizeAgentId(id);
    assert.ok(safe.length > 0, `must not produce an empty id (#72): ${JSON.stringify(id)}`);
    assert.ok(
      path.resolve("/data/sessions", `${safe}-x`).startsWith("/data/sessions/"),
      `fallback must still be contained (#72)`,
    );
  }
});

test("a leading dot cannot create a hidden directory (#72)", () => {
  assert.ok(!sanitizeAgentId(".hidden").startsWith("."), "no hidden dirs (#72)");
  assert.ok(!sanitizeAgentId("...").startsWith("."), "no dot-only ids (#72)");
});

test("the ACP adapter's raw sessionId is contained (#72)", async () => {
  // the actual reported path: session/load with a traversal-shaped id
  const sessionsRoot = await mkdtemp(path.join(tmpdir(), "p72s-"));
  const hostile = "../../escape";
  const safe = sanitizeAgentId(hostile);
  const dir = path.resolve(sessionsRoot, `${safe}-abc123`);
  assert.ok(
    dir.startsWith(sessionsRoot + path.sep),
    `the ACP sessionId must not escape the sessions root (#72): ${dir}`,
  );
  // and the shape the adapter passes is an id, not a path
  assert.ok(!safe.includes("/") && !safe.includes(path.sep), `no separators survive (#72): ${safe}`);
});
