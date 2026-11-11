/**
 * The tab title comes from the shell's OSC 0/2 sequence, not from polling (#238).
 *
 * "2秒間隔のポーリングはコスパ悪い" — and it is also the wrong mechanism: a program tells the terminal what to call it with
 * `ESC ] 0 ; text BEL`, which is what every real terminal shows in its title bar. MEASURED against a real pty here: bash
 * writes `ESC ] 0 ; user@host:/cwd BEL` on every prompt, and the sequence routinely spans two chunks — so the parser reads the
 * accumulated tail rather than each chunk.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { oscTitleFrom } from "../src/server/terminals.ts";

test("the last OSC title in the stream wins", () => {
  const s = "\u001b]0;first\u0007some output\u001b]2;second\u0007";
  assert.equal(oscTitleFrom(s), "second", "a later title replaces an earlier one");
});

test("the ST-terminated form is recognised too", () => {
  assert.equal(oscTitleFrom("x\u001b]0;vim notes.md\u001b\\y"), "vim notes.md");
});

test("a title split across chunks is still found in the accumulated tail", () => {
  // what the pty actually hands over: the sequence is cut in half
  const whole = "prompt$ \u001b]0;user@host:/tmp/ws\u0007";
  assert.equal(oscTitleFrom(whole.slice(0, 12) + whole.slice(12)), "user@host:/tmp/ws");
  assert.equal(oscTitleFrom(whole.slice(0, 12)), null, "the first half alone is not a title");
});

test("no sequence means no title", () => {
  assert.equal(oscTitleFrom("plain output\r\n"), null);
  assert.equal(oscTitleFrom("\u001b]0;\u0007"), null, "an empty title is not a name");
});
