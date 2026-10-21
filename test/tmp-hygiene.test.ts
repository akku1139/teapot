/**
 * Test artifacts must go through the shared root, or they are never cleanable.
 *
 * ## The measurement behind this
 *
 * `pnpm test:clean` reported **7,034 entries / 1,088 MB** of test litter accumulated in the
 * temp directory. The single largest contributor was one file: `test/mcp-oauth.test.ts`
 * created its fixture with a bare `mkdtemp(os.tmpdir())` and never removed anything, so every
 * run left another directory behind — **335** of them.
 *
 * That is why `test/helpers/tmp-root.ts` exists: it puts every artifact under ONE root
 * (`<TMPDIR>/teapot-tests`, or `$TEAPOT_TEST_TMP`), so cleanup is a single `rm -rf` of a
 * directory the helpers own. Scattered names force a cleanup script to GUESS by name, and
 * guessing is how a tidying script deletes somebody else's data.
 *
 * A rule in AGENTS.md is not enforcement — the leaking file was written after the helper
 * already existed. This test is the enforcement: it fails the moment a new bare `mkdtemp`
 * appears in the suite.
 *
 * It reads source, which the project otherwise bans. The exception is deliberate and narrow:
 * the property being asserted IS a property of the source text (which API was called), there
 * is no runtime behaviour to observe, and the failure mode is invisible until somebody counts
 * directories months later. It uses `readSource()` and `stripSourceComments()` so a CRLF
 * checkout behaves like LF (#126) and a comment cannot satisfy it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource, stripSourceComments } from "./helpers/source.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** every `.ts` under test/, excluding the helper that legitimately owns the call */
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
    // readSource normalises CRLF; stripSourceComments leaves string literals intact, so the
    // prose explaining this rule cannot report itself and a path inside a string still can.
    const code = stripSourceComments(readSource(f));
    for (const line of code.split("\n")) {
      if (!/\bmkdtemp(Sync)?\s*\(/.test(line)) continue;
      if (/mkdtempInRoot/.test(line)) continue; // the helper itself
      if (/testTmpRoot\s*\(/.test(line)) continue; // derived from the shared root
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

/**
 * A file that creates temp dirs must also REMOVE them.
 *
 * MEASURED: `/tmp/teapot-tests` had grown to 2350 directories / 723MB, and the largest single
 * source was one test file writing ~1000 files per invocation across six tests and never
 * deleting any of it — 195MB on its own. The shared root makes cleanup POSSIBLE (`pnpm
 * test:clean` can find everything); nothing made it HAPPEN, so the directory only grew.
 *
 * The rule is deliberately about the FILE, not each call site: a `finally`/`after` that removes
 * the dirs is enough, whatever shape it takes. Threading cleanup through every helper's return
 * value is more code than it is worth.
 */
test("the shared helpers REMOVE what they hand out (#tmp)", () => {
  /**
   * MEASURED: `/tmp/teapot-tests` had reached 2350 directories / 723MB and nothing removed them.
   * The shared root made cleanup *possible* (`pnpm test:clean` could find everything); nothing
   * made it HAPPEN, so it only grew. One file was writing ~1000 files per invocation and never
   * deleting them — 195MB on its own.
   *
   * The first version of this check asked every test FILE to clean up after itself. That found
   * 32 offenders, which is the wrong shape of fix: it makes correctness depend on 32 independent
   * authors remembering. Registering ownership in the helper means one place is responsible, and
   * a test cannot forget.
   */
  const helper = readSource(path.join(here, "helpers", "tmp-root.ts"));

  for (const fn of ["mkdtempInRoot", "mkdtempInRootSync"]) {
    const at = helper.indexOf(`export ${fn === "mkdtempInRoot" ? "async " : ""}function ${fn}`);
    assert.ok(at > 0, `precondition: ${fn} exists`);
    const body = helper.slice(at, helper.indexOf("\n}", at));
    assert.match(
      body,
      /ownDir\(/,
      `${fn} must REGISTER the directory it creates. Cleanup cannot depend on each of the ~30 ` +
        `call sites remembering — measured: 32 files did not, and the root grew to 723MB`,
    );
  }

  // and the registration must actually remove, on a hook that fires even when a test fails
  assert.match(helper, /process\.on\("exit"/, "removal must run on process exit, not per test");
  assert.match(helper, /rmSync\(/, "…and actually delete");
});
