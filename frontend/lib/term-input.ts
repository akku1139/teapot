/**
 * What typed input may leave for the pty.
 *
 * xterm answers the terminal's own queries — `OSC 11;?` (background colour), `OSC 10;?`, a device-attributes request — by
 * emitting a REPLY through `onData`, the same channel keyboard input uses. That channel is wired straight to the pty, so the
 * reply was typed into the shell: `gh auth` asked for the background colour, got `11;rgb:ffff/f5f5/f8f8` echoed back at a
 * prompt, and `gh auth login` refused with `could not prompt: unexpected escape sequence from terminal: ['\x1b' ']']`.
 *
 * A terminal reply is a complete escape sequence and nothing else. Keyboard input is either plain text or the same
 * sequences the terminal EMULATOR is asked to pass through (an arrow key, a paste), and those are produced by the user — so
 * the rule is narrow on purpose: drop a reply that is ENTIRELY one of the report sequences below.
 */

/** OSC (`ESC ] … BEL|ST`) and DCS/CSI replies xterm produces when it ANSWERS a query. */
const TERMINAL_REPLY =
  /^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[[?>]?[0-9;]*c|\x1b\[[0-9]+;[0-9]+R)+$/;

export function isTerminalReply(data: string): boolean {
  return data.length > 0 && TERMINAL_REPLY.test(data);
}

/** The subset of `onData` traffic that belongs to the pty. */
export function inputForPty(data: string): string {
  return isTerminalReply(data) ? "" : data;
}
