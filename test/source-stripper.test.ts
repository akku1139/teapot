import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripSourceComments } from "./helpers/source.ts";

test("a line comment is removed, code is kept", () => {
  assert.equal(stripSourceComments("const a = 1; // note"), "const a = 1; ");
});

test("a regex literal ending in an escaped slash is NOT read as a comment (#75)", () => {
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
  const files = [
    "src/server/api.ts",
    "src/master.ts",
    "src/agent/agent.ts",
    "frontend/App.tsx",
    "frontend/lib/session-scope.ts",
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
