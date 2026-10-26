/**
 * ANSI SGR ESCAPES IN TOOL OUTPUT ARE RENDERED AS COLOUR, NOT AS BYTES.
 *
 * Reported from a Renode session with the raw escapes pasted in:
 *
 *     ^[[0m^[[91m       ^
 *     ^[[0m[16:27:52.4706] [WARNING] Monitor: Could not tokenize here:
 *
 * Every bash result that coloured its output showed the escape bytes literally, which is both
 * unreadable and wastes the vertical space the colours exist to organise. MEASURED on that
 * session's log: 53 tool results contain ESC.
 *
 * The cases that matter are the ones that made it look unfixable by a regex strip: colour state
 * must survive across text, a bare CR redraw must not print both halves, and non-SGR control
 * sequences must vanish rather than appear or blank the card.
 */
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
  // this is the shape Renode emits: one escape per character, each reset in between
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
  /**
   * Progress-style output writes `10%\r 20%\r 30%` and a terminal shows ` 30%`. Printing all of
   * them is how a tool card fills with noise the operator never saw in their shell.
   */
  assert.equal(text("10%\r20%\r30%"), "30%");
  // but CRLF is an ordinary newline and must be preserved as one
  assert.equal(text("a\r\nb"), "a\nb");
});

test("non-SGR control sequences are DROPPED, never printed (#ansi)", () => {
  // erase-line / cursor moves: honouring them would blank a card, printing them would be noise
  assert.equal(text("before\x1b[2Kafter"), "beforeafter");
  assert.equal(text("\x1b[1;1Hhome"), "home");
  // an OSC title sequence (ESC ] 0 ; title BEL)
  assert.equal(text("\x1b]0;my title\x07text"), "text");
  // a lone ESC with nothing valid after it
  assert.equal(text("a\x1bb"), "ab");
});

test("extended colour is consumed, and its parameters are not misread (#ansi)", () => {
  /**
   * `38;5;n` (256-colour) and `38;2;r;g;b` (truecolour) put NUMBERS in the same parameter list as
   * the basic codes. If they are not skipped, `38;5;196` ends up applying 196 as if it were a
   * colour code — or worse, part of it lands as a basic colour and the output is randomly tinted.
   */
  const a = ansiRuns("\x1b[38;5;196mred-ish\x1b[0m");
  assert.equal(a[0]!.text, "red-ish");
  assert.deepEqual(a[0]!.classes, ["ansi-fg-ext"], "256-colour maps to a neutral class");
  const b = ansiRuns("\x1b[38;2;10;20;30mtruecolour\x1b[0m");
  assert.equal(b[0]!.text, "truecolour");
  assert.deepEqual(b[0]!.classes, ["ansi-fg-ext"]);
  // and the survivors of a mixed list still apply
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
  // the log may be truncated mid-stream; the text must still be readable
  assert.equal(text("\x1b[91mtruncated"), "truncated");
});
