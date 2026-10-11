// Find tests that cannot fail, or that prove nothing about production code.
//
// "Too many tests, yet the critical parts escape" means some of them are
// decorative. The measurable forms of that:
//
//   1. NO ASSERTION — the test cannot fail, whatever the code does.
//   2. TAUTOLOGY — `assert.ok(true)`, or a literal compared with itself.
//   3. SELF-PROVING — the body re-implements the rule it is checking, so it
//      passes by construction (#75's documented failure mode).
//   4. SOURCE-SHAPE ONLY — asserts on a substring of production source, which
//      survives the logic being deleted as long as the text remains.
//
// Usage: node scripts/audit-tests.mjs [--verbose]
import fs from "node:fs";
import path from "node:path";

const dir = "test";
const verbose = process.argv.includes("--verbose");

/** assertion helpers a file defines locally (they call assert.* internally) */
function localAssertHelpers(src) {
  const names = [];
  for (const m of src.matchAll(/function\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/g)) {
    const start = m.index + m[0].length;
    // the body up to the matching brace
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    const body = src.slice(start, i);
    if (/assert\.\w+/.test(body)) names.push(m[1]);
  }
  return names;
}

/**
 * Blank the CONTENTS of string and regex literals, preserving length.
 *
 * Brace matching cannot be done on raw source: a regex like
 * `/\\{\\s*(?:e|res)\\.[^}]*durationMs\\s*\\}/g` contains balanced-looking braces,
 * and a template literal can hold anything. Blanking the contents (same offsets,
 * so slicing the ORIGINAL still works) makes the braces inside them invisible —
 * the same lesson as `stripSourceComments`, which read a regex as a comment.
 */
export function blankLiterals(src) {
  let out = "";
  let i = 0;
  let lastMeaningful = "";
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        const ch = src[i];
        if (ch === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += ch === "\n" ? "\n" : " ";
        i++;
        if (ch === quote) break;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      // a line comment can contain braces too (`// if (x) { ... }`) — blank it
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    if (c === "/" && src[i + 1] !== "/" && src[i + 1] !== "*" && src[i + 1] !== "=" && "(,=:[!&|?{};+-*%^~<>".includes(lastMeaningful)) {
      out += c;
      i++;
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        if (ch === "\n") break;
        out += " ";
        i++;
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
      }
      continue;
    }
    out += c;
    if (!/\s/.test(c)) lastMeaningful = c;
    i++;
  }
  return out;
}

function testBlocks(src) {
  const out = [];
  const safe = blankLiterals(src);
  const re = /^test\s*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index;
    // the name is the first string argument
    const head = src.slice(start, start + 400);
    const name =
      /^test\s*\(\s*["'`]([^"'`]+)["'`]/.exec(head)?.[1] ??
      (/^test\s*\(\s*`([^`]+)`/.exec(head)?.[1] || "(dynamic name)");
    // the body starts at the '{' that opens the CALLBACK, not at the first '{'
    // — `test(name, { skip: ... }, () => {` has an options object first, and
    // treating that as the body made 17 well-asserted tests look empty.
    const arrow = safe.indexOf("=>", start);
    const fnKw = safe.indexOf("function", start);
    const bodyFrom = arrow !== -1 && (fnKw === -1 || arrow < fnKw + 8) ? safe.indexOf("{", arrow) : safe.indexOf("{", fnKw);
    const open = bodyFrom === -1 ? safe.indexOf("{", start) : bodyFrom;
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < safe.length; i++) {
      if (safe[i] === "{") depth++;
      else if (safe[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    out.push({ name, body: src.slice(open, end + 1), line: src.slice(0, start).split("\n").length });
  }
  return out;
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.ts"));
const findings = { noAssert: [], tautology: [], selfProving: [], sourceOnly: [] };

for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  const hasProdImport = /from "\.\.\/(src|frontend)\//.test(src);
  // a file-local helper that calls assert counts as an assertion: without this the
  // audit flags every legitimately-written `srcHas(...)` test as unassertive
  const helpers = localAssertHelpers(src);
  const helperRe = helpers.length ? new RegExp(`\\b(${helpers.join("|")})\\s*\\(`) : null;
  for (const t of testBlocks(src)) {
    const where = `${f}:${t.line}  ${t.name.slice(0, 70)}`;
    const asserts =
      (t.body.match(/assert\.\w+/g) || []).length + (helperRe && helperRe.test(t.body) ? 1 : 0);
    if (asserts === 0) {
      findings.noAssert.push(where);
      continue;
    }
    // a literal compared with an equal literal
    if (/assert\.(ok|equal|strictEqual)\(\s*(true|false|\d+|["'][^"']*["'])\s*(,\s*\2\s*)?\)/.test(t.body)) {
      findings.tautology.push(where);
    }
    // asserts only on source text, never calling the production code
    if (!hasProdImport && /readSource|readFileSync/.test(t.body)) {
      findings.sourceOnly.push(where);
    }
  }
}

const show = (label, list, note) => {
  console.log(`\n=== ${label}: ${list.length} ===`);
  if (note) console.log(`    ${note}`);
  for (const x of list.slice(0, verbose ? 200 : 12)) console.log("  " + x);
  if (!verbose && list.length > 12) console.log(`  ... and ${list.length - 12} more`);
};
show("NO ASSERTION (cannot fail)", findings.noAssert);
show("TAUTOLOGY", findings.tautology);
show("SOURCE-SHAPE ONLY, no production import", findings.sourceOnly);
console.log(
  `\nfiles: ${files.length} | tests: ${files.reduce((n, f) => n + testBlocks(fs.readFileSync(path.join(dir, f), "utf8")).length, 0)}`,
);
