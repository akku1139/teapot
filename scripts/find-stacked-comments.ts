#!/usr/bin/env node
/**
 * Find STACKED comments: two or more comment groups with no code between them.
 *
 * The pattern this exists for:
 *
 *     /* more old comment *\/
 *     /*
 *      * old comment
 *      *\/
 *     // new comment
 *     function xxx() {
 *
 * Only the LAST group is documentation; the ones above it were orphaned when a declaration between
 * them was deleted or moved. That is worse than untidy — JSDoc tooling attaches the FIRST block to
 * the declaration below, so a `SYSTEM_TEMPLATE` docblock can end up documenting `KEEP_RECENT_TOKENS`.
 * MEASURED in `src/agent/agent.ts`: three stacked docblocks above `memoryDigestText()`, two of them
 * describing methods that no longer exist there.
 *
 * Distinct from the JSX case (`{/* … *\/}` inside a render), which `lint` already covers.
 *
 * Usage:
 *   node scripts/find-stacked-comments.ts            # report
 *   node scripts/find-stacked-comments.ts --strict   # exit 1 when any remain (for CI)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const DIRS = ["src", "frontend", "scripts", "test"];
const SKIP = new Set(["node_modules", "public", "dist", ".git"]);

type Group = { kind: "line" | "block"; start: number; end: number };
type Hit = { file: string; line: number; groups: Group[]; nextCode: string };

const files: string[] = [];
const walk = (dir: string): void => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e) || e.startsWith(".")) continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs)$/.test(e)) files.push(p);
  }
};
for (const d of DIRS) walk(path.join(ROOT, d));

/** read the comment group starting at `i`, or null when line `i` is not a comment */
const groupAt = (lines: string[], i: number): Group | null => {
  const t = lines[i]!.trim();
  if (t.startsWith("//")) {
    let j = i;
    while (j < lines.length && lines[j]!.trim().startsWith("//")) j++;
    return { kind: "line", start: i, end: j - 1 };
  }
  if (t.startsWith("/*")) {
    let j = i;
    while (j < lines.length && !lines[j]!.includes("*/")) j++;
    // a `/* … *\/` that opens and closes on one line still ends here
    return { kind: "block", start: i, end: Math.min(j, lines.length - 1) };
  }
  return null;
};

const isCode = (line: string): boolean => {
  const t = line.trim();
  return t !== "" && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*") && !t.startsWith("*/");
};

const hits: Hit[] = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  let i = 0;
  while (i < lines.length) {
    const first = groupAt(lines, i);
    if (!first) {
      i++;
      continue;
    }
    const groups: Group[] = [first];
    i = first.end + 1;
    // keep consuming comment groups while ONLY comments separate them
    for (;;) {
      const g = groupAt(lines, i);
      if (!g) break;
      // A BLANK LINE between groups means the author separated them deliberately — they are not
      // stacked. Without this, two unrelated docblocks close together read as one orphaned run.
      if (groups.length > 0 && lines[i - 1]?.trim() === "") break;
      groups.push(g);
      i = g.end + 1;
    }
    /**
     * A SECTION BANNER is not an orphan.
     *
     * `/* ---------- themes ---------- *\/` is a navigational marker, and the block under it
     * explains the code that follows. That is a deliberate grouping, so a run whose FIRST group is
     * a banner is skipped. Judging "is this comment stale" by shape alone cannot be done; the
     * banner case is the one shape that is unambiguously intentional.
     */
    const isBanner = (g: Group): boolean => {
      const text = lines.slice(g.start, g.end + 1).join("\n");
      return /^\/\*\s*-{3,}/.test(text.trim());
    };
    if (groups.length >= 2 && !isBanner(groups[0]!)) {
      const next = lines[i] ?? "";
      hits.push({
        file: path.relative(ROOT, file),
        line: groups[0]!.start + 1,
        groups,
        nextCode: (isCode(next) ? next.trim() : "").slice(0, 60),
      });
    }
  }
}

/** how many groups stack, and what the last one is documenting */
const summary = new Map<string, Hit[]>();
for (const h of hits) {
  const key = h.file;
  const list = summary.get(key) ?? [];
  list.push(h);
  summary.set(key, list);
}

const strict = process.argv.includes("--strict");
const plain = process.argv.includes("--plain");

if (hits.length === 0) {
  console.log("no stacked comment runs");
} else if (plain) {
  for (const h of hits) console.log(`${h.file}:${h.line}`);
} else {
  console.log(`${hits.length} stacked comment run(s) in ${summary.size} file(s)\n`);
  const sorted = [...summary.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [file, list] of sorted) {
    console.log(`  ${file}  (${list.length})`);
    for (const h of list.slice(0, 4)) {
      const shape = h.groups.map((g) => g.kind[0]!.toUpperCase()).join("+");
      console.log(`    :${h.line}  ${h.groups.length} groups [${shape}]` + (h.nextCode ? `  → ${h.nextCode}` : ""));
    }
    if (list.length > 4) console.log(`    … ${list.length - 4} more`);
  }
  console.log(
    "\nOnly the LAST group documents the code below it. Keep that one; a group that describes a\n" +
      "deleted or moved declaration goes with it (git has the history).",
  );
}

process.exit(strict && hits.length > 0 ? 1 : 0);
