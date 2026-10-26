#!/usr/bin/env node
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_ROOT = path.join(tmpdir(), "teapot-tests");
const override = process.env.TEAPOT_TEST_TMP;
const root = override || DEFAULT_ROOT;
const apply = process.argv.includes("--apply");

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

const looksLikeOurs =
  path.basename(root) === "teapot-tests" || entries.some((e) => e.startsWith("run-") || e.includes("-"));
if (!override && path.resolve(root) !== path.resolve(DEFAULT_ROOT)) {
  console.error(`refusing to delete ${root}: not the default test root`);
  process.exit(1);
}
if (!looksLikeOurs) {
  console.error(
    `refusing to delete ${root}: it does not look like a test root (expected a "teapot-tests" directory, or run-*/<prefix>-* entries). Refused rather than guess.`,
  );
  process.exit(1);
}
await rm(root, { recursive: true, force: true });
console.log(`\nremoved ${root}`);
