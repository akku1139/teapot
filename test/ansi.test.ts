import { test } from "node:test";
import assert from "node:assert/strict";
import { ansiRuns, stripAnsi, hasAnsi } from "../frontend/lib/ansi.ts";

const text = (s: string) => ansiRuns(s).map((r) => r.text).join("");

test("a colour span becomes a class and its text stays intact (#ansi)", () => {
  const runs = ansiRuns("\x1b[91m(monitor) \x1b[0minclude @/tmp/t.resc");
  assert.deepEqual(
    runs.map((r) => ({ t: r.text, c: r.classes })),
    [
      { t: "(monitor) ", c: ["ansi-fg-bright-red"] },
      { t: "include @/tmp/t.resc", c: [] },
    ],
    "the escape must not appear in the output, and the reset must end the span",
  );
  assert.equal(stripAnsi("\x1b[91mx\x1b[0m"), "x", "the copied text must be the readable text");
});

test("colour survives across several runs and re-opens after a reset (#ansi)", () => {
  const src = "\x1b[92mR\x1b[0m\x1b[92me\x1b[0m\x1b[92md\x1b[0m";
  const runs = ansiRuns(src);
  assert.equal(text(src), "Red", "the letters must join up, not be lost");
  assert.ok(
    runs.every((r) => r.text === "" || r.classes.includes("ansi-fg-bright-green")),
    `every letter keeps its colour; got ${JSON.stringify(runs)}`,
  );
});

test("attributes are combined, not overwritten (#ansi)", () => {
  const runs = ansiRuns("\x1b[1;4;31mboth\x1b[0m");
  assert.deepEqual(runs[0]!.classes.sort(), ["ansi-bold", "ansi-fg-red", "ansi-underline"].sort());
});

test("a bare CR is a line REDRAW, not a second line (#ansi)", () => {
  assert.equal(text("10%\r20%\r30%"), "30%");
  assert.equal(text("a\r\nb"), "a\nb");
});

test("non-SGR control sequences are DROPPED, never printed (#ansi)", () => {
  assert.equal(text("before\x1b[2Kafter"), "beforeafter");
  assert.equal(text("\x1b[1;1Hhome"), "home");
  assert.equal(text("\x1b]0;my title\x07text"), "text");
  assert.equal(text("a\x1bb"), "ab");
});

test("extended colour is consumed, and its parameters are not misread (#ansi)", () => {
  const a = ansiRuns("\x1b[38;5;196mred-ish\x1b[0m");
  assert.equal(a[0]!.text, "red-ish");
  assert.deepEqual(a[0]!.classes, ["ansi-fg-ext"], "256-colour maps to a neutral class");
  const b = ansiRuns("\x1b[38;2;10;20;30mtruecolour\x1b[0m");
  assert.equal(b[0]!.text, "truecolour");
  assert.deepEqual(b[0]!.classes, ["ansi-fg-ext"]);
  const c = ansiRuns("\x1b[1;38;5;9mbold-ext\x1b[0m");
  assert.deepEqual(c[0]!.classes.sort(), ["ansi-bold", "ansi-fg-ext"]);
});

test("text with no escapes passes through unchanged and coalesces to one run (#ansi)", () => {
  const runs = ansiRuns("plain output\nsecond line");
  assert.equal(runs.length, 1, "one run, so a plain result adds no spans to the DOM");
  assert.deepEqual(runs[0]!.classes, []);
  assert.equal(runs[0]!.text, "plain output\nsecond line");
});

test("hasAnsi is a cheap gate, and empty input is empty output (#ansi)", () => {
  assert.equal(hasAnsi("\x1b[31mx"), true);
  assert.equal(hasAnsi("no escapes"), false);
  assert.deepEqual(ansiRuns(""), []);
  assert.equal(stripAnsi(""), "");
});

test("an unterminated colour still renders its text (#ansi)", () => {
  assert.equal(text("\x1b[91mtruncated"), "truncated");
});
