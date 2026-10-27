#!/usr/bin/env node
/**
 * Run the suite ONCE and print only what failed.
 *
 * The problem this replaces: `node --test test/*.test.ts` prints ~1600 `✔` lines, so finding the
 * failures means either re-running with a grep (another 2 minutes) or scrolling a screenful of noise.
 * Two runs per iteration to learn one fact.
 *
 * This runs once, keeps the per-test result in memory, and prints:
 *   - a one-line summary,
 *   - each failing test's name and its assertion/stack excerpt,
 *   - the files to look at.
 *
 * Usage:
 *   node scripts/test-failures.ts            # everything
 *   node scripts/test-failures.ts blobs      # only files whose name matches
 *   node scripts/test-failures.ts --keep     # also show the ✓ lines (rarely wanted)
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const keepPassing = args.includes("--keep");
const filters = args.filter((a) => !a.startsWith("--"));

const testDir = path.join(import.meta.dirname, "..", "test");
let files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join(testDir, f));
if (filters.length) files = files.filter((f) => filters.some((t) => f.includes(t)));
if (!files.length) {
  console.error(`no test files matched ${JSON.stringify(filters)}`);
  process.exit(1);
}

/**
 * `--test-reporter=tap` gives one line per test with a stable prefix, which is far easier to parse
 * than the default spec reporter's prettified tree.
 */
const child = spawn(
  process.execPath,
  ["--test", "--test-reporter=tap", ...files],
  { stdio: ["ignore", "pipe", "pipe"] },
);

const failures: { name: string; detail: string[] }[] = [];
let current: { name: string; detail: string[] } | null = null;
let inErrorBlock = false;
let passing = 0;
let total = 0;
let buffered = "";

const handleLine = (line: string): void => {
  const ok = /^(ok|not ok) \d+ - (.*)$/.exec(line);
  if (ok) {
    total++;
    const [, status, name] = ok;
    if (status === "ok") {
      passing++;
      current = null;
    } else {
      current = { name: name.trim(), detail: [] };
      failures.push(current);
    }
    inErrorBlock = false;
    return;
  }
  if (!current) return;
  /**
   * The useful text lives in TAP's `error: |-` block, and nothing else does.
   *
   * The sibling keys — `location`, `failureType`, `expected`, `actual`, `operator`, `stack` — describe
   * HOW node reports the failure, not what went wrong; the stack in particular is 6 identical
   * `Test.runInAsyncScope` frames per test. Reading only the error block gives the operator the one
   * line they need.
   */
  const errStart = /^\s*error: \|-\s*$/.exec(line);
  if (errStart) {
    inErrorBlock = true;
    return;
  }
  if (inErrorBlock) {
    // the block ends at the first line that starts a new key (`  code: …`) or dedents to nothing
    if (/^\s{2}[a-zA-Z_]+:/.test(line)) {
      inErrorBlock = false;
      return;
    }
    const text = line.trim();
    if (text) current.detail.push(`  ${text}`);
  }
};

child.stdout.on("data", (b: Buffer) => {
  buffered += b.toString("utf8");
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const l of lines) handleLine(l);
});
child.stderr.on("data", (b: Buffer) => {
  // the app's own console output; only worth showing when something fails
  const text = b.toString("utf8");
  if (keepPassing) process.stderr.write(text);
});

child.on("close", (code) => {
  if (buffered) handleLine(buffered);

  if (keepPassing) {
    console.log(`\n${passing}/${total} passed`);
  }
  if (!failures.length) {
    console.log(`all ${total} tests passed${code === 0 ? "" : " (but the runner exited non-zero)"}`);
    process.exit(code === 0 ? 0 : 1);
  }

  console.log(`\n${failures.length} FAILED of ${total}:\n`);
  for (const f of failures) {
    console.log(`✖ ${f.name}`);
    for (const d of f.detail.slice(0, 12)) console.log(`    ${d.trim()}`);
    if (f.detail.length > 12) console.log(`    … ${f.detail.length - 12} more lines`);
    console.log("");
  }
  process.exit(1);
});
