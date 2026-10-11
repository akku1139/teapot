#!/usr/bin/env node
/**
 * Remove the shared test workspace, or report what is in it.
 *
 *   node scripts/clean-test-tmp.mjs          # report only (the safe default)
 *   node scripts/clean-test-tmp.mjs --apply  # delete it
 *
 * Every test artifact now lives under ONE directory (`<TMPDIR>/teapot-tests`, or
 * `$TEAPOT_TEST_TMP`), so cleanup no longer has to identify anything by name. That
 * matters: name-based cleanup is a guess, and guessing is how a tidying script deletes
 * somebody else's data. Measured before this: 2006 teapot fixture directories, 439 MB,
 * distinguishable from other projects' files only by walking each one's contents.
 *
 * The dry run is the default for the same reason, and it is what you want between
 * experiments — "did the run leave anything behind?"
 */
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_ROOT = path.join(tmpdir(), "teapot-tests");
const override = process.env.TEAPOT_TEST_TMP;
const root = override || DEFAULT_ROOT;
const apply = process.argv.includes("--apply");

/** total bytes under a directory */
async function measure(dir) {
  let total = 0;
  let files = 0;
  for (const e of await readdir(dir)) {
    const child = path.join(dir, e);
    const s = await stat(child).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) {
      const sub = await measure(child);
      total += sub.total;
      files += sub.files;
    } else {
      total += s.size;
      files++;
    }
  }
  return { total, files };
}

const entries = await readdir(root).catch(() => null);
if (entries === null) {
  console.log(`clean: nothing at ${root}`);
  process.exit(0);
}
const { total, files } = await measure(root);
console.log(`root          : ${root}${override ? "  (from $TEAPOT_TEST_TMP)" : ""}`);
console.log(`entries       : ${entries.length}`);
console.log(`files         : ${files}`);
console.log(`size          : ${(total / 1e6).toFixed(1)} MB`);

if (!apply) {
  console.log("\ndry run — pass --apply to delete.");
  process.exit(0);
}

// Only ever the root this project creates. An override is honoured because the operator
// pointed us at it deliberately; without one, refuse anything that is not the default
// path, so a stray TMPDIR can never turn this into an `rm -rf` of an arbitrary tree.
if (!override && path.resolve(root) !== path.resolve(DEFAULT_ROOT)) {
  console.error(`refusing to delete ${root}: not the default test root`);
  process.exit(1);
}
await rm(root, { recursive: true, force: true });
console.log(`\nremoved ${root}`);
