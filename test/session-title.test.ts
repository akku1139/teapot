import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionTitleFrom } from "../src/session-title.ts";

test("the title is the first MEANINGFUL line of the operator's prompt", () => {
  assert.equal(
    sessionTitleFrom("teapotのいくつかを修正して\n1. #142\n2. タイムライン"),
    "teapotのいくつかを修正して",
    "a plain opening line is the title",
  );
  assert.equal(
    sessionTitleFrom("## Fix the sidebar\n\nmore detail"),
    "Fix the sidebar",
    "heading markers are stripped, not shown",
  );
  assert.equal(
    sessionTitleFrom("- first bullet\n- second"),
    "first bullet",
    "a list marker is not part of the subject",
  );
});

test("a fenced block is CONTENT, not the subject (#155)", () => {
  assert.equal(
    sessionTitleFrom("```\nlog line one\nlog line two\n```\n\n#155 を進めて"),
    "155 を進めて",
    "the prose after the fence is the title",
  );
  assert.equal(sessionTitleFrom("```\nsecret\nmore"), null, "an open fence hides its body");
});

test("a line with no subject is skipped for the next one (#155)", () => {
  assert.equal(
    sessionTitleFrom("https://github.com/akku1139/teapot/issues/155\n\nセッション名を自動生成"),
    "セッション名を自動生成",
    "a bare URL is not a title",
  );
  assert.equal(sessionTitleFrom("2.\n3.\nactual subject"), "actual subject", "bare list numbers are skipped");
});

test("no usable text yields null rather than an empty string (#155)", () => {
  assert.equal(sessionTitleFrom(""), null);
  assert.equal(sessionTitleFrom("   \n\n  "), null);
  assert.equal(sessionTitleFrom(undefined), null);
  assert.equal(sessionTitleFrom(null), null);
  assert.equal(sessionTitleFrom(123 as never), null, "a non-string must not throw");
});

test("a long line is clipped on a word boundary with an ellipsis (#155)", () => {
  const long = "word ".repeat(40).trim();
  const t = sessionTitleFrom(long);
  assert.ok(t, "a long line still yields a title");
  assert.ok(t!.length <= 61, `must fit a sidebar row, got ${t!.length}`);
  assert.ok(t!.endsWith("…"), `a clipped title must show that it was cut: ${t}`);
  assert.ok(!/\s…$/.test(t!), "the ellipsis must not sit after a stray space");
});

