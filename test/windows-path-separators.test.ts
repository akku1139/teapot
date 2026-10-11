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
import { readdirSync, readFileSync } from "node:fs";
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

test("no test reads a file via URL.pathname — it breaks on Windows (#126, #110)", () => {
  const offenders: string[] = [];
  for (const f of testFiles(here)) {
    if (path.basename(f) === "windows-path-separators.test.ts") continue; // this file
    const src = readFileSync(f, "utf8");
    // COMMENTS MUST BE STRIPPED before scanning. The first version of this guard did
    // not, so the helper's own documentation — which quotes the forbidden pattern to
    // explain why it is wrong — failed the test on Windows.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    code.split("\n").forEach((line, i) => {
      if (/new URL\([^)]*\)\s*\.pathname/.test(line)) offenders.push(`${path.relative(here, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `use readSourceUrl(url) or fileURLToPath(url) instead of URL.pathname (#126): ${offenders.join(", ")}`,
  );
});

test("fileURLToPath is the conversion to use for a file URL (#126)", () => {
  // NOTE on what is assertable here. `fileURLToPath` is PLATFORM-DEPENDENT: on
  // Windows it converts `file:///D:/a/x.ts` to `D:\a\x.ts`, while on Linux (this
  // runner) the same URL legitimately stays `/D:/a/x.ts` — Linux has no drives, so
  // it cannot be asked to produce one. Asserting the Windows output here would be
  // asserting something false about the platform running the test.
  //
  // What IS checkable anywhere: it resolves a proper file URL to a path, and on
  // POSIX it agrees with `pathname` — which is exactly why the `.pathname` mistake
  // stays invisible on Linux and only ever shows up on the Windows job.
  const posixUrl = new URL("file:///home/dev/x.ts");
  assert.equal(fileURLToPath(posixUrl), "/home/dev/x.ts", "a POSIX file URL resolves to its path");
  assert.equal(
    fileURLToPath(posixUrl),
    posixUrl.pathname,
    "and it EQUALS pathname on POSIX — the reason the bug is Windows-only",
  );
  assert.match(
    fileURLToPath(new URL("../src/agent/agent.ts", import.meta.url)),
    /agent[\\/]agent\.ts$/,
    "and a test-relative URL resolves to a real path on both platforms",
  );
});
