// Prove a comment-cleanup diff changed no CODE.
//
// A cleanup pass that silently alters a condition is the worst possible outcome:
// the tests may still pass while behaviour drifts. So compare the CODE of the old
// and new revision with comments removed.
//
// The comparison must ignore blank lines and leading indentation: removing a
// comment SHIFTS every later line, so a positional line-by-line diff reports
// spurious changes (and a re-indent is prose-preserving). What must be identical
// is the sequence of non-blank CODE lines, whitespace-normalised.
//
// Usage: node scripts/audit-comment-only-diff.mjs <base-rev>
import { execFileSync } from "node:child_process";
import { stripSourceComments } from "../test/helpers/source.ts";

const base = process.argv[2] ?? "HEAD";
const files = execFileSync("git", ["diff", "--name-only", base, "--", "src", "frontend"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx)$/.test(f));

/** the code tokens that must not change: comments gone, whitespace irrelevant */
function codeLines(src) {
  return stripSourceComments(src)
    .replace(/\r\n/g, "\n")
    // whitespace removed entirely, so a REFORMAT (a signature joined onto one
    // line, a re-indent) is not reported as a code change while any token change
    // still is
    .replace(/\s+/g, "");
}

let changed = 0;
for (const f of files) {
  const before = execFileSync("git", ["show", `${base}:${f}`], { encoding: "utf8" });
  const after = execFileSync("cat", [f], { encoding: "utf8" });
  const a = codeLines(before);
  const b = codeLines(after);
  if (a === b) continue;

  // show the first divergence so a real change is reviewable
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  changed++;
  console.log(`CODE CHANGED: ${f}`);
  console.log(`   old: ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))}`);
  console.log(`   new: ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`);
}
console.log(
  `\n${files.length} changed files; ${changed} with a CODE difference ` +
    `(${changed === 0 ? "cleanup was comment-only" : "REVIEW THESE"})`,
);
process.exit(changed === 0 ? 0 : 1);
