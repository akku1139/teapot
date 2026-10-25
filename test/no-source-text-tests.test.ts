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
  // the same read through the helper, imported dynamically
  /import\(\s*["'`]\.\/helpers\/source\.ts["'`]\s*\)\s*\)\s*\.readSource\(\s*["'`](?:src|frontend)\/[^"'`]*\.tsx?["'`]/,
];

/** `frontend/app.css` and any other stylesheet: allowed, see the note above */
const CSS_OK = /readSource\(\s*["'`][^"'`]*\.css["'`]\s*\)/;

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

test("stylesheets are the only source a test may read (#meta)", () => {
  /**
   * The allow-list is enforced, not assumed: every `readSource` in `test/` must name a `.css` file,
   * or this fails. Without this, adding a new `readSource("src/agent.ts")` in a form the BANNED
   * patterns above happen not to match would slip through.
   */
  const offenders: string[] = [];
  for (const file of testFiles) {
    if (file === "no-source-text-tests.test.ts") continue;
    const src = readFileSync(path.join(TEST_DIR, file), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*/gm, "");
    for (const m of code.matchAll(/readSource\(\s*(["'`][^"'`]+["'`])/g)) {
      if (!CSS_OK.test(`readSource(${m[1]})`)) offenders.push(`${file}: readSource(${m[1]})`);
    }
  }
  assert.deepEqual(offenders, [], `readSource may only read a stylesheet:\n  ${offenders.join("\n  ")}`);
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
  // and it must NOT refuse the CSS contract, which is the one legitimate read
  assert.ok(!BANNED.some((re) => re.test(`readSource("frontend/app.css")`)), "a stylesheet read is allowed");
  assert.ok(CSS_OK.test(`readSource("frontend/app.css")`), "and recognised as the allowed kind");
});
