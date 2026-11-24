/**
 * A workspace reached through a SYMLINK is still the workspace (#macos).
 *
 * The macOS job failed with `path escapes workspace via symlink: r.c` on a file the test had just written inside its own
 * fixture, and `/api/agents/:id/tree` answered 400 for a directory that was plainly there. One cause: `safeJoin` resolved
 * the candidate path with `realpath` and then compared it against `cwd` AS GIVEN.
 *
 * macOS makes this the default case — `/tmp` is a symlink to `/private/tmp` — so every fixture under it looked like it sat
 * outside its own workspace. The same shape appears on any host with a symlinked home or a bind-mounted checkout, which is
 * why the fix belongs in the resolver rather than in the macOS workflow.
 *
 * happy-dom/unit tests cannot see this: the fixture must be REACHED through a link, which is what this builds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import path from "node:path";
import { safeJoin } from "../src/agent/tools.ts";

test("a path inside a symlinked workspace does not look like an escape", () => {
  const real = mkdtempInRootSync("symws-");
  mkdirSync(path.join(real, "sub"), { recursive: true });
  writeFileSync(path.join(real, "sub", "r.c"), "int main(void){return 0;}\n");

  const link = `${real}-link`;
  symlinkSync(real, link);

  // PRECONDITION: the fixture must actually be reached through the link, or this proves nothing
  assert.notEqual(realpathSync(link), link, "the fixture path is a symlink, like /tmp on macOS");

  const out = safeJoin(link, "sub/r.c");
  assert.equal(out, path.join(link, "sub/r.c"), "the caller gets the path it asked for, unresolved");

  // and the file is readable through what it returned
  assert.ok(safeJoin(link, "sub") !== "", "a directory works too — this is the /tree path");
});

test("a real escape is still refused, symlink or not", () => {
  const real = mkdtempInRootSync("symws2-");
  const link = `${real}-link`;
  symlinkSync(real, link);

  assert.throws(() => safeJoin(link, "../outside.txt"), /escapes/, "`..` is still an escape");
  assert.throws(() => safeJoin(link, "/etc/passwd"), /escapes/, "an absolute path is still an escape");

  // and the symlink check itself still works: a link INSIDE the workspace pointing out of it
  const outside = mkdtempInRootSync("symout-");
  writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  symlinkSync(path.join(outside, "secret.txt"), path.join(real, "escape.txt"));
  assert.throws(
    () => safeJoin(link, "escape.txt"),
    /escapes workspace via symlink/,
    "a symlink that leads out of the workspace is still refused",
  );
});
