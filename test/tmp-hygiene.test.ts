/**
 * Test artifacts must go through the shared root, or they are never cleanable.
 *
 * ## The measurement behind this
 *
 * `pnpm test:clean` reported **7,034 entries / 1,088 MB** of test litter accumulated under
 * `/tmp`. The single largest contributor was one file: `test/mcp-oauth.test.ts` called a bare
 * `mkdtemp(path.join(os.tmpdir(), "teapot-oauth-"))` and never removed anything, so every run
 * left another directory behind — **335** of them.
 *
 * That is why `test/helpers/tmp-root.ts` exists: it puts every artifact under ONE root
 * (`<TMPDIR>/teapot-tests`, or `$TEAPOT_TEST_TMP`), so cleanup is a single `rm -rf` of a
 * directory the helpers own. Scattered names force a cleanup script to GUESS by name, and
 * guessing is how a tidying script deletes somebody else's data.
 *
 * A rule in AGENTS.md is not enforcement — the file that leaked had been written after the
 * helper existed. This test is the enforcement: it fails the moment a new bare `mkdtemp`
 * appears in the suite.
 *
 * It reads source, which the project otherwise bans. The exception is deliberate and narrow:
 * the thing being asserted IS a property of the source text (which API was called), there is
 * no runtime behaviour to observe, and the failure mode is invisible until somebody counts
 * directories in /tmp months later.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** every `.ts` under test/, excluding the helper that legitimately calls mkdtemp */
function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(p));
    else if (e.name.endsWith(".ts") && !p.endsWith(path.join("helpers", "tmp-root.ts"))) out.push(p);
  }
  return out;
}

test("no test creates a temp dir outside the shared root (#tmp)", () => {
  const files = testFiles(here);
  // PRECONDITION: the walk found the suite, or "no offenders" proves nothing
  assert.ok(files.length > 100, `expected to scan the whole test tree, got ${files.length} files`);

  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // Strip comments FIRST: the prose explaining this rule names `mkdtemp` and would
    // otherwise report itself. Only real call sites matter.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n");
    for (const line of code.split("\n")) {
      if (!/\bmkdtemp(Sync)?\s*\(/.test(line)) continue;
      if (/mkdtempInRoot/.test(line)) continue; // the helper itself
      // allow the call only when it is derived from testTmpRoot()
      if (/testTmpRoot\s*\(/.test(line)) continue;
      offenders.push(`${path.relative(here, f)}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these tests create a temp dir outside the shared root, so `pnpm test:clean` cannot find " +
      "it. Use mkdtempInRoot/mkdtempInRootSync from test/helpers/tmp-root.ts:\n" +
      offenders.join("\n"),
  );
});
