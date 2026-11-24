/**
 * A terminal REPLY must not be typed into the shell (#276).
 *
 * "`gh auth` すると謎のエスケープシーケンスが流れてくる" — the prompt came back containing `11;rgb:ffff/f5f5/f8f8`, and
 * `gh auth login` refused with `could not prompt: unexpected escape sequence from terminal: ['\x1b' ']']`.
 *
 * xterm answers the terminal's own queries (`OSC 11;?` for the background colour, device attributes, cursor position) by
 * emitting a reply through `onData` — the same callback keyboard input uses, which is wired straight to the pty. The pty
 * echoes it, so the reply appears at the prompt as if it had been typed.
 *
 * The rule has to be narrow: arrow keys, pastes and ordinary text all travel on the same channel and must keep working.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { inputForPty, isTerminalReply } from "../frontend/lib/term-input.ts";

const ESC = "\x1b";

test("the reported colour report is dropped", () => {
  assert.equal(isTerminalReply(`${ESC}]11;rgb:ffff/f5f5/f8f8${ESC}\\`), true);
  assert.equal(isTerminalReply(`${ESC}]11;rgb:ffff/f5f5/f8f8\x07`), true, "BEL-terminated is the same reply");
  assert.equal(inputForPty(`${ESC}]11;rgb:ffff/f5f5/f8f8${ESC}\\`), "");
  assert.equal(inputForPty(`${ESC}]10;rgb:0000/0000/0000${ESC}\\`), "", "the foreground report too");
});

test("device attributes and cursor-position replies are dropped", () => {
  assert.equal(isTerminalReply(`${ESC}[?1;2c`), true);
  assert.equal(isTerminalReply(`${ESC}[12;40R`), true);
});

test("real input still goes to the shell", () => {
  for (const s of ["l", "ls -la\r", "\x03", `${ESC}[A`, `${ESC}[1;5C`, "gh auth login", `\x1b[200~paste\x1b[201~`]) {
    assert.equal(isTerminalReply(s), false, `${JSON.stringify(s)} is the operator typing`);
    assert.equal(inputForPty(s), s);
  }
});
