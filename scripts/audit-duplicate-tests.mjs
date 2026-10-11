// Find tests that assert the SAME production pattern in more than one file.
//
// Redundant coverage is what makes a suite large without making it stronger: the
// same rule checked three times costs three times the maintenance and catches
// nothing extra. This groups every regex/string assertion by the pattern it
// matches, and reports patterns asserted from two or more files.
//
// Usage: node scripts/audit-duplicate-tests.mjs
import fs from "node:fs";
import path from "node:path";

const files = fs.readdirSync("test").filter((f) => f.endsWith(".test.ts"));
/** pattern text -> files that assert it */
const byPattern = new Map();

for (const f of files) {
  const src = fs.readFileSync(path.join("test", f), "utf8");
  // regex literals
  for (const m of src.matchAll(/\/(?:[^/\\\n[]|\\.|\[[^\]]*\])+\/[gimsuy]*/g)) {
    const p = m[0];
    // skip trivial/structural patterns that legitimately appear everywhere
    if (p.length < 12) continue;
    if (/^\/\^?\s*\*?\/?/.test(p) && p.length < 18) continue;
    const set = byPattern.get(p) ?? new Set();
    set.add(f);
    byPattern.set(p, set);
  }
}

const dupes = [...byPattern].filter(([, set]) => set.size > 1).sort((a, b) => b[1].size - a[1].size);
console.log(`=== patterns asserted from 2+ files: ${dupes.length} ===`);
for (const [p, set] of dupes.slice(0, 25)) {
  console.log(`\n  ${p.slice(0, 78)}`);
  console.log(`    in ${set.size} files: ${[...set].join(", ")}`);
}

// how many test files assert the same production file without importing it
console.log("\n=== files with source-shape assertions but NO production import ===");
for (const f of files) {
  const src = fs.readFileSync(path.join("test", f), "utf8");
  const importsProd = /from\s+"\.\.\/(src|frontend)\//.test(src);
  const readsSrc = /readSource|readFileSync/.test(src);
  if (!importsProd && readsSrc) {
    const assertions = (src.match(/assert\.\w+/g) || []).length;
    const tests = (src.match(/^test\(/gm) || []).length;
    console.log(`  ${f.padEnd(46)} ${String(tests).padStart(3)} tests, ${String(assertions).padStart(3)} asserts`);
  }
}
