#!/usr/bin/env node
/**
 * Run the subset of the test suite that is meaningful on this platform.
 *
 * #110 (item 4): the Windows CI job needs a way to run "the tests that can
 * actually pass here". Two obvious approaches, and why this is not either:
 *
 *   - glob a filename pattern (`*-posix.test.ts`) — a test becomes
 *     Windows-invisible by RENAMING it, silently. That is how a real Windows
 *     failure hides.
 *   - maintain a hand-written allowlist — it rots, and a new POSIX-only test is
 *     silently run on Windows until someone notices it fail.
 *
 * So the classification is IN THE FILE. A test that cannot pass on Windows
 * imports `markPosixOnly` from this helper and calls it; the runner then skips
 * it, loudly. Anything unlisted is RUN — so the default is "tested", and opting
 * out is explicit and greppable.
 *
 * Usage:  node scripts/run-portable-tests.mjs [--list]
 */
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const MARKER = "markPosixOnly";

function testDir() {
  // scripts/ -> repo root
  return path.resolve(import.meta.dirname, "..", "test");
}

function isPosixOnly(file) {
  try {
    const src = readFileSync(path.join(testDir(), file), "utf8");
    return src.includes(MARKER);
  } catch {
    return false;
  }
}

const all = readdirSync(testDir())
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

const posixOnly = all.filter(isPosixOnly);
const portable = all.filter((f) => !isPosixOnly(f));

if (process.argv.includes("--list")) {
  console.log(`portable (${portable.length}):`);
  for (const f of portable) console.log(`  ${f}`);
  console.log(`\nposix-only (${posixOnly.length}):`);
  for (const f of posixOnly) console.log(`  ${f}`);
  process.exit(0);
}

console.log(`platform : ${process.platform}`);
console.log(`running  : ${portable.length} test files`);
console.log(`skipping : ${posixOnly.length} (opted out with ${MARKER}())\n`);

const args = ["--test", ...portable.map((f) => path.join("test", f))];
const r = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(r.status ?? 1);