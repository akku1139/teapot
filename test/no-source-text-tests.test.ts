import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * No test may assert on IMPLEMENTATION SOURCE.
 *
 * Reading `App.tsx` / `agent.ts` / `rows.tsx` and matching a regex against it cannot fail for a real
 * reason: it pins the SPELLING of code that has to work at RUNTIME. Renaming a property, extracting
 * a helper, or wrapping a branch in `if (false)` all leave the regex green — the last one keeps a
 * test passing while the feature is dead. MEASURED in this repo: 32 files and 217 cases were doing
 * exactly this, and among them were "tests" that were GREEN through a button whose handler had been
 * frozen by an untracked refactor.
 *
 * This guard exists because the rule was written down and then violated anyway — by the same agent
 * that wrote it down. A rule enforced only by memory gets re-broken; the point of spending a test on
 * the rule itself is that adding the next source-comparing test fails here, at the moment someone
 * adds it, with the reason attached.
 *
 * WHAT IS ALLOWED, and why it is a different thing:
 *
 *   - `frontend/app.css` — happy-dom does NO LAYOUT, so geometry cannot be asserted as pixels.
 *     Checking that a rule declares `flex: 1` or `overflow-y: auto` is asserting the rendered
 *     contract, which is the only way to state it without a real engine. It still names selectors,
 *     so it is second-best, but it is not the same failure mode: a class rename breaks the UI and
 *     the test together.
 *   - files that never touch `test/helpers/source.ts` at all.
 */
const ROOT = path.join(import.meta.dirname, "..");
const TEST_DIR = path.join(ROOT, "test");

/** reading implementation code — `.ts`/`.tsx` under `frontend/` or `src/` — is the banned thing */
const BANNED = [
  /readSource\(\s*["'`](?:src|frontend)\/[^"'`]*\.tsx?["'`]\s*\)/,
  /**
   * A STYLESHEET is source text too.
   *
   * `app.css` used to be the one allowed read, on the theory that happy-dom does no layout so geometry had to be asserted
   * as CSS. What that produced was 19 files of `cssRuleBody(...)` assertions: they break on renames that fix nothing and stay
   * green while the UI is broken, exactly the failure `readSource` was banned for. The property they were really protecting
   * is a LAYOUT outcome, which belongs in a real browser (`scripts/harness`) or nowhere.
   */
  /readSource\(\s*["'`][^"'`]*\.css["'`]\s*\)/,
  // the same read through the helper, imported dynamically
  /import\(\s*["'`]\.\/helpers\/source\.ts["'`]\s*\)\s*\)\s*\.readSource\(\s*["'`](?:src|frontend)\/[^"'`]*\.tsx?["'`]/,
];

const testFiles = readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts"));

test("no test asserts on implementation source (#meta)", () => {
  const offenders: string[] = [];

  for (const file of testFiles) {
    if (file === "no-source-text-tests.test.ts") continue; // this file names the patterns on purpose
    const src = readFileSync(path.join(TEST_DIR, file), "utf8");
    // strip comments so a file EXPLAINING the ban (as several do) is not counted as breaking it
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*/gm, "");

    for (const line of code.split("\n")) {
      if (BANNED.some((re) => re.test(line))) {
        offenders.push(`${file}: ${line.trim().slice(0, 100)}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these tests compare IMPLEMENTATION SOURCE instead of behaviour, so they pass while the feature " +
      "is dead and fail on a rename. Test a pure function's output, or drive the built bundle in " +
      "scripts/smoke-web.mjs:\n  " +
      offenders.join("\n  "),
  );
});



test("a stylesheet a test does read goes through the CRLF-normalising helper (#meta)", () => {
  /**
   * The only stylesheet reads left in this suite exist for a CSS contract (happy-dom does no layout, so geometry has to be
   * stated as CSS). Reading one with a bare `readFileSync` is the Windows-only failure MEASURED on the v0.37.231 run:
   *
   *     ✖ the label inside a summary is still the only part allowed to shrink
   *       AssertionError: no rule for .embed summary > b,
   *       .embed summary > .meta {
   *
   * A selector written across two lines cannot be found in a CRLF checkout, and nothing in the suite objects on Linux, where the
   * author runs it. `readSourceUrl` normalises the line endings — `test/helpers/source.ts` exists for exactly this — so the rule
   * is "no raw read of a stylesheet", enforced rather than remembered.
   */
  const offenders: string[] = [];
  for (const file of testFiles) {
    if (file === "no-source-text-tests.test.ts") continue;
    const src = readFileSync(path.join(TEST_DIR, file), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*/gm, "");
    for (const line of code.split("\n")) {
      if (/readFileSync\([^)]*\.css/.test(line)) offenders.push(`${file}: ${line.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "read a stylesheet with readSourceUrl() from test/helpers/source.ts, or a CRLF checkout fails where nobody can iterate:\n  " +
      offenders.join("\n  "),
  );
  // positive control: the shapes that were actually written
  for (const line of [
    `const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");`,
    `const css = readFileSync(path.join(ROOT, "frontend/app.css"), "utf8");`,
  ]) {
    assert.ok(/readFileSync\([^)]*\.css/.test(line), `the guard must see this shape: ${line}`);
  }
});

test("the guard would actually catch a source-comparing test (#meta)", () => {
  /**
   * A guard that cannot fire is worse than none — it is a false assurance. MEASURED earlier in this
   * repo: a check looked for an event type that did not exist, so it never matched anything and
   * stayed green while the bug it was meant to catch shipped.
   *
   * These are the exact shapes that were deleted, so the patterns are proven against real text
   * rather than against my idea of what a violation looks like.
   */
  const sample = [
    `const app = stripSourceComments(readSource("frontend/App.tsx"));`,
    `const src = readSource("src/agent/agent.ts").replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");`,
    `const block = fnBlock(readSource("frontend/components/rows.tsx"), "function ToolRow(");`,
  ];
  for (const line of sample) {
    assert.ok(
      BANNED.some((re) => re.test(line)),
      `the guard must refuse this shape, or it cannot catch the tests it exists for: ${line}`,
    );
  }
  // and a stylesheet read is refused like any other source text now
  assert.ok(
    BANNED.some((re) => re.test(`readSource("frontend/app.css")`)),
    "a stylesheet read is source-matching too, and must be refused",
  );
});
