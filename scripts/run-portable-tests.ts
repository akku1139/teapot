#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { stripSourceComments } from "../test/helpers/source.ts";

const MARKER = "markPosixOnly";

function testDir() {
  return path.resolve(import.meta.dirname, "..", "test");
}

function isPosixOnly(file) {
  try {
    const src = readFileSync(path.join(testDir(), file), "utf8");
    return new RegExp(`\\b${MARKER}\\s*\\(`).test(stripSourceComments(src));
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
