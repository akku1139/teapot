// Which production code has NO test that exercises it?
//
// The complaint this answers: "too many tests, yet the critical parts escape".
// Test COUNT says nothing about that — what matters is whether the code a bug
// would live in is reachable from any test at all.
//
// Two measures, both static and cheap:
//
//   1. module reachability — does ANY test import this file (directly or through
//      another module it imports)? A file nothing loads is untested by
//      construction.
//   2. exported symbols that no test file mentions — narrower, and useful when a
//      module is imported for one function while the rest rides along untested.
//
// Usage: node scripts/audit-test-reachability.mjs
import fs from "node:fs";
import path from "node:path";

/** every .ts/.tsx under a dir, excluding build output */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".git", "public", "dist"].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const prod = [...walk("src"), ...walk("frontend")];
const tests = fs.readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => path.join("test", f));
const helpers = fs.existsSync("test/helpers") ? walk("test/helpers") : [];
const testSrc = [...tests, ...helpers].map((f) => fs.readFileSync(f, "utf8")).join("\n");

/** normalise an import specifier to a repo-relative path */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.join(path.dirname(fromFile), spec).replace(/\\/g, "/");
  // the repo imports WITH the extension (`from "../src/master.ts"`), so an
  // appended one would look for `master.ts.ts` and find nothing — which reported
  // every module as unreachable.
  const cands = /\.(ts|tsx|js|mjs)$/.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  for (const cand of cands) if (fs.existsSync(cand)) return cand;
  return null;
}

/** modules reachable from the test files, following imports */
const reachable = new Set();
const queue = [];
for (const t of tests) {
  const src = fs.readFileSync(t, "utf8");
  for (const m of src.matchAll(/from\s+"([^"]+)"/g)) queue.push([t, m[1]]);
}
while (queue.length) {
  const [from, spec] = queue.pop();
  const target = resolveImport(from, spec);
  if (!target || reachable.has(target)) continue;
  reachable.add(target);
  const src = fs.readFileSync(target, "utf8");
  for (const m of src.matchAll(/from\s+"([^"]+)"/g)) queue.push([target, m[1]]);
}

console.log("=== production modules NO test reaches (directly or transitively) ===");
let unreachable = 0;
for (const f of prod) {
  if (reachable.has(f)) continue;
  // the CLI entry and types-only modules are expected here
  unreachable++;
  const lines = fs.readFileSync(f, "utf8").split("\n").length;
  console.log(`  ${f.padEnd(34)} ${String(lines).padStart(5)} lines`);
}
console.log(`\nunreachable: ${unreachable} of ${prod.length} production modules`);

console.log("\n=== exported symbols no test file mentions ===");
let dead = 0;
for (const f of prod.filter((x) => reachable.has(x))) {
  const src = fs.readFileSync(f, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export (?:async )?function ([A-Za-z_]\w*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export const ([A-Za-z_]\w*)/g)) names.add(m[1]);
  const unused = [...names].filter((n) => !new RegExp(`\\b${n}\\b`).test(testSrc));
  if (unused.length) {
    dead += unused.length;
    console.log(`  ${f}: ${unused.join(", ")}`);
  }
}
console.log(`\nexported symbols never named by a test: ${dead}`);
