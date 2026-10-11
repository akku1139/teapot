// Find source-pattern assertions that are too broad to protect anything.
//
// A test like `assert.match(app, /setPendingMsgs\(/)` passes if the string appears
// ANYWHERE — so it cannot fail while any one of N call sites remains, and it says
// nothing about the specific one the fix was about. The measurable form: count how
// often the asserted pattern occurs in the target file. One occurrence is a real
// anchor; many means the assertion is nearly free.
//
// Usage: node scripts/audit-weak-source-assertions.mjs
import fs from "node:fs";
import path from "node:path";

const tests = fs.readdirSync("test").filter((f) => f.endsWith(".test.ts"));

for (const t of tests) {
  const src = fs.readFileSync(path.join("test", t), "utf8");
  if (!/readSource|readFileSync/.test(src)) continue;

  // which production files does it read?
  const targets = [];
  for (const m of src.matchAll(/readSource\(\s*new URL\(\s*"([^"]+)"/g)) targets.push(m[1]);
  const bodies = targets
    .map((rel) => {
      const p = path.join("test", rel).replace(/\\/g, "/");
      try {
        return { p, text: fs.readFileSync(p, "utf8") };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!bodies.length) continue;

  const weak = [];
  // assert.match(<var>, /pattern/)
  for (const m of src.matchAll(/assert\.match\(\s*(\w+)\s*,\s*\/((?:[^/\\\n[]|\\.|\[[^\]]*\])+)\/([a-z]*)/g)) {
    const pat = m[2];
    if (pat.length < 8) continue;
    let re;
    try {
      re = new RegExp(pat, m[3] ?? "");
    } catch {
      continue;
    }
    for (const b of bodies) {
      const hits = (b.text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []).length;
      if (hits >= 3) weak.push({ pat, hits, file: b.p });
    }
  }

  if (weak.length) {
    console.log(`\n${t}`);
    for (const w of weak.slice(0, 8)) {
      console.log(`   /${w.pat.slice(0, 50)}/  matches ${w.hits}x in ${w.file}`);
    }
  }
}
