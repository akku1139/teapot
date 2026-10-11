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
    src.split("\n").forEach((line, i) => {
      // the shape that broke: a URL immediately followed by `.pathname`, with the
      // result used as a path. A commented-out or prose mention does not count.
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
      if (/new URL\([^)]*\)\s*\.pathname/.test(code)) offenders.push(`${path.relative(here, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `use readSourceUrl(url) or fileURLToPath(url) instead of URL.pathname (#126): ${offenders.join(", ")}`,
  );
});

test("fileURLToPath is the conversion that is correct on both platforms (#126)", () => {
  // NOTE on what is assertable here. `fileURLToPath` is PLATFORM-DEPENDENT: on
  // Windows it converts `file:///D:/a/x.ts` to `D:\a\x.ts`, while on Linux (this
  // runner) it legitimately leaves the same URL as `/D:/a/x.ts` — Linux has no
  // drives, so it cannot be asked to produce one. Asserting the Windows output here
  // would therefore be asserting something false about the platform running the
  // test.
  //
  // What IS checkable anywhere: the function resolves to a path rather than leaving
  // a URL, and it agrees with `pathname` on POSIX — which is exactly why the
  // `.pathname` mistake stays invisible on Linux and only ever shows up on Windows.
  const posixUrl = new URL("file:///home/dev/x.ts");
  assert.equal(fileURLToPath(posixUrl), "/home/dev/x.ts", "a POSIX file URL resolves to its path");
  assert.equal(
    fileURLToPath(posixUrl),
    posixUrl.pathname,
    "and it EQUALS pathname on POSIX — the reason the bug is Windows-only",
  );
  // on Windows this same call returns a drive-absolute path; the assertion lives in
  // the Windows CI job's own run of this file, not in a hard-coded shape here
  assert.match(
    fileURLToPath(new URL("file:./relative.ts")),
    /relative\.ts$/,
    "and a relative file URL still resolves (no URL left behind)",
  );
});
