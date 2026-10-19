/**
 * `.pathname` on a `file:` URL is NOT a filesystem path.
 *
 * #126: on Windows `new URL("../src/x.ts", import.meta.url).pathname` is
 * `/D:/a/teapot/src/x.ts`, and `readFileSync` treats a leading `/` plus a drive
 * letter as a RELATIVE path — it then searched `D:\D:\a\teapot\...` and threw
 * ENOENT. The Windows job failed on 8 files while Linux was green, so the whole
 * suite looked healthy except on the one platform nobody can iterate on.
 *
 * #110 hit the SAME trap first (the bundled-skills root), was fixed at that call
 * site, and the mistake came back in nine more. A comment did not prevent it, so
 * this asserts the pattern mechanically: use `readSourceUrl(url)` or
 * `fileURLToPath(url)` instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** every .ts under test/ (including helpers), which is where this bites */
function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

test("the conversion yields a path that EXISTS — which is the actual bug (#126)", () => {
  // The failure this whole file is about was ENOENT: the path did not exist. So
  // assert exactly that, using a test-relative URL like every call site does.
  //
  // NO hard-coded path shapes here. `fileURLToPath` is PLATFORM-DEPENDENT — on
  // Windows it returns a drive path (`D:\a\...`) and on POSIX a `/…` path, and even
  // a premise as simple as "a POSIX-style file URL converts to /home/..." is false on
  // Windows. Two earlier versions of this test failed on the Windows runner for
  // asserting platform-specific shapes instead of the property that matters.
  const url = new URL("../src/agent/agent.ts", import.meta.url);
  const resolved = fileURLToPath(url);
  assert.ok(
    existsSync(resolved),
    `the conversion must produce a path that exists, or every caller gets ENOENT (#126): ${resolved}`,
  );
  assert.match(resolved, /agent[\\/]agent\.ts$/, "and it must point at the file the URL named");
  // and it agrees with path resolution of the same target
  assert.equal(
    resolved,
    path.resolve(fileURLToPath(new URL("..", import.meta.url)), "src", "agent", "agent.ts"),
    "the converted URL and a resolved relative path must name the same file",
  );
});
