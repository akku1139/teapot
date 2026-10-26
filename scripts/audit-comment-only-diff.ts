import { execFileSync } from "node:child_process";
import { stripSourceComments } from "../test/helpers/source.ts";

const base = process.argv[2] ?? "HEAD";
const files = execFileSync("git", ["diff", "--name-only", base, "--", "src", "frontend"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx)$/.test(f));

function codeLines(src) {
  return stripSourceComments(src)
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, "");
}

let changed = 0;
for (const f of files) {
  const before = execFileSync("git", ["show", `${base}:${f}`], { encoding: "utf8" });
  const after = execFileSync("cat", [f], { encoding: "utf8" });
  const a = codeLines(before);
  const b = codeLines(after);
  if (a === b) continue;

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
