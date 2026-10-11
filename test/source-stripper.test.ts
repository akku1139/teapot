/**
 * `stripSourceComments` is the guard that stops a test asserting on a COMMENT
 * instead of on code. If the stripper itself is wrong, that guard silently stops
 * working — a test can be satisfied by prose again, or worse, see code that was
 * truncated mid-line.
 *
 * The regex-literal case was found by running the stripper across all of `src/`
 * and `frontend/`: `/^https?:\/\//` ends with an escaped slash followed by the
 * closing slash, so the source contains an adjacent `//`, and the stripper
 * swallowed the rest of the line as a comment. That is exactly the false
 * confidence the helper exists to remove, so it is pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripSourceComments } from "./helpers/source.ts";

test("a line comment is removed, code is kept", () => {
  assert.equal(stripSourceComments("const a = 1; // note"), "const a = 1; ");
});

test("a regex literal ending in an escaped slash is NOT read as a comment (#75)", () => {
  // this is the exact shape in src/server/api.ts
  const src = "if (!/^https?:\\/\\//.test(baseUrl)) return c.json({ error: \"valid baseUrl required\" }, 400);";
  const out = stripSourceComments(src);
  assert.ok(
    out.includes("valid baseUrl required"),
    `the rest of the line must survive: ${JSON.stringify(out)}`,
  );
  assert.ok(out.includes("^https?"), "and the regex itself must survive");
});

test("a `/` inside a regex character class does not close it (#75)", () => {
  const out = stripSourceComments("const r = /[/]+/g; const after = 1;");
  assert.ok(out.includes("const after = 1;"), `the literal must not swallow the line: ${JSON.stringify(out)}`);
});

test("division and strings containing slashes are left alone (#75)", () => {
  assert.ok(stripSourceComments("const x = a / b; const y = 1;").includes("const y = 1;"));
  assert.ok(stripSourceComments("const s = \"a//b\"; const t = 2;").includes("const t = 2;"));
});

test("the whole production tree strips without losing code (#75)", () => {
  // the check that FOUND the regex bug: a misread regex truncates the line, and
  // the truncated text collapses to nearly nothing. 30% is well below the real
  // ratios (measured 34%–70%) and still catches a file that lost its body.
  const files = [
    "src/server/api.ts",
    "src/master.ts",
    "src/agent/agent.ts",
    "frontend/App.tsx",
    "frontend/session-scope.ts",
  ];
  for (const f of files) {
    const raw = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const out = stripSourceComments(raw);
    assert.ok(
      out.length > raw.length * 0.3,
      `${f}: stripping removed too much (${out.length}/${raw.length}) — a regex was misread`,
    );
    assert.ok(/[A-Za-z]/.test(out), `${f}: nothing left`);
  }
});
