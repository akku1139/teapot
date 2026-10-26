import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const TEST_DIR = path.join(ROOT, "test");

const BANNED = [
  /readSource\(\s*["'`](?:src|frontend)\/[^"'`]*\.tsx?["'`]\s*\)/,
  /import\(\s*["'`]\.\/helpers\/source\.ts["'`]\s*\)\s*\)\s*\.readSource\(\s*["'`](?:src|frontend)\/[^"'`]*\.tsx?["'`]/,
];

/** `frontend/app.css` and any other stylesheet: allowed, see the note above */
const CSS_OK = /readSource\(\s*["'`][^"'`]*\.css["'`]\s*\)/;

const testFiles = readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts"));

test("no test asserts on implementation source (#meta)", () => {
  const offenders: string[] = [];

  for (const file of testFiles) {
    if (file === "no-source-text-tests.test.ts") continue; 
    const src = readFileSync(path.join(TEST_DIR, file), "utf8");
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
  assert.ok(!BANNED.some((re) => re.test(`readSource("frontend/app.css")`)), "a stylesheet read is allowed");
  assert.ok(CSS_OK.test(`readSource("frontend/app.css")`), "and recognised as the allowed kind");
});
