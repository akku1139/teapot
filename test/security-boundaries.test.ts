import { test } from "node:test";
import assert from "node:assert/strict";
import { symlink, access } from "node:fs/promises";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { useTempDir, useTempDirs } from "./helpers/tmp.ts";
import path from "node:path";
import { executeTool, safeJoin } from "../src/agent/tools.ts";
import { sanitizeAgentId } from "../src/master.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

markPosixOnly("POSIX filesystem paths");

test("a write through a symlink to a real directory outside is refused (#74)", async () => {
  await withPair("p74a-", "out74a-", async (ws, outside) => {
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
});

test("a nested path through such a symlink is refused too (#74)", async () => {
  await withPair("p74b-", "out74b-", async (ws, outside) => {
    await symlink(outside, path.join(ws, "esc"), "dir");
    const r = await executeTool(
      "write_file",
      JSON.stringify({ path: "esc/deep/nested/pwned.txt", content: "PWNED" }),
      { cwd: ws, defaultTimeoutMs: 5000, maxOutputBytes: 10_000 } as never,
    );
    assert.equal(r.ok, false, "nested writes through the symlink must be refused (#74)");
    await assert.rejects(access(path.join(outside, "deep", "nested", "pwned.txt")));
  });
});

test("a symlink to a FILE outside is refused (#74)", async () => {
  await twoRoots((ws, outside) => {
    writeFileSync(path.join(outside, "secret.txt"), "s");
    symlinkSync(path.join(outside, "secret.txt"), path.join(ws, "link.txt"), "file");
    assert.throws(() => safeJoin(ws, "link.txt"), /escapes workspace via symlink/);
  });
});

test("a symlink to a NOT-YET-CREATED directory outside is refused (#74)", async () => {
  await twoRoots((ws, outside) => {
    symlinkSync(path.join(outside, "future"), path.join(ws, "dangling"), "dir");
    assert.throws(() => safeJoin(ws, "dangling/y.txt"), /escapes workspace via symlink/);
  });
});

test("legitimate writes still work (#74)", () => {
  assert.doesNotThrow(() => safeJoin("/ws", "new-file.txt"));
  assert.doesNotThrow(() => safeJoin("/ws", "brand/new/dir/file.txt"));
  assert.doesNotThrow(() => safeJoin("/ws", "a/b/c/deep.txt"));
});

test("traversal is still refused lexically (#74)", () => {
  for (const p of ["../outside.txt", "../../etc/passwd", "/etc/passwd", "a/../../b"]) {
    assert.throws(() => safeJoin("/ws", p), /escapes workspace/, `${p} must be refused`);
  }
});

test("a symlink INSIDE the workspace still works (#74)", async () => {
  await useTempDir("s-", (ws) => {
    mkdirSync(path.join(ws, "real"), { recursive: true });
    symlinkSync(path.join(ws, "real"), path.join(ws, "link"), "dir");
    assert.doesNotThrow(() => safeJoin(ws, "link/file.txt"));
  });
});

async function twoRoots(fn: (ws: string, outside: string) => void | Promise<void>) {
  await useTempDirs(["s-", "s-"], (dirs) => fn(dirs[0]!, dirs[1]!));
}
async function withPair(
  a: string,
  b: string,
  fn: (ws: string, outside: string) => Promise<void> | void,
): Promise<void> {
  await useTempDirs([a, b], (dirs) => fn(dirs[0]!, dirs[1]!));
}

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
  const sessionsRoot = (await useTempDir("p72s-", (d) => d));
  const hostile = "../../escape";
  const safe = sanitizeAgentId(hostile);
  const dir = path.resolve(sessionsRoot, `${safe}-abc123`);
  assert.ok(
    dir.startsWith(sessionsRoot + path.sep),
    `the ACP sessionId must not escape the sessions root (#72): ${dir}`,
  );
  assert.ok(!safe.includes("/") && !safe.includes(path.sep), `no separators survive (#72): ${safe}`);
});
