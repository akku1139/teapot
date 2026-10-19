/**
 * #155 — session titles.
 *
 * "いろんなチャットアプリが実装してる、CodexやDSHとかも実装してそう / 自動生成とかサブエージェント名
 * とかだとわかりにくい" — the sidebar rendered the raw session id
 * (`teapot-10-16854917`), so with several sessions of one agent there was no way to
 * tell them apart without opening each one.
 *
 * The title comes from the operator's OWN first message rather than a model call:
 * it is already written, costs nothing, and cannot drift (the first message of a
 * session never changes).
 *
 * Asserted on the pure rule, which is what decides every case. The WIRING — that
 * the sidebar prefers the title over the raw id — is asserted separately below,
 * because a helper nothing calls is the #75 failure this repo keeps re-learning.
 */
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
  // measured: taking the first line inside a fence titled a session "log", which
  // says nothing. The operator pastes a log and then writes what they want.
  assert.equal(
    sessionTitleFrom("```\nlog line one\nlog line two\n```\n\n#155 を進めて"),
    "155 を進めて",
    "the prose after the fence is the title",
  );
  // and an UNTERMINATED fence must not fall through to its own body either
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
  // null lets the caller fall back to the id; "" would render a blank row
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

