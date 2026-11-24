/**
 * Can `script` provide a pty IN THIS PROCESS in the way this code spawns it?
 *
 * It cannot everywhere, and not for a reason this project controls. Apple's `script.c` checks stdin before doing anything:
 *
 *     if (tcgetattr(STDIN_FILENO, &tt) == -1 || ioctl(STDIN_FILENO, TIOCGWINSZ, &win) == -1) {
 *     #ifdef __APPLE__
 *         if (errno != ENOTTY && errno != ENODEV) err(1, "tcgetattr/ioctl");
 *
 * A Node `stdio: "pipe"` is a SOCKETPAIR, so on macOS `script` exits 1 with
 * `tcgetattr/ioctl: Operation not supported on socket` before it allocates anything. MEASURED on the macOS job, with both
 * argv dialects: `DIAG probe ... bsd=1 stderr="script: tcgetattr/ioctl: Operation not supported on socket"`.
 *
 * A fixture that asserts "a pty slave is exposed" therefore tests the HOST, not the product. The tests that need a real pty
 * ask this first and skip with the reason, the same way a missing `ffmpeg` is handled — an absent capability is not a
 * passing assertion, and it is not a failure either.
 */
import { spawnSync } from "node:child_process";

export function ptyViaScriptAvailable(): { ok: boolean; reason: string } {
  if (process.platform === "win32") return { ok: false, reason: "no script(1) on Windows" };
  const probe = spawnSync("script", ["-qec", "true", "/dev/null"], { encoding: "utf8" });
  if (probe.status === 0) return { ok: true, reason: "gnu script" };
  const bsd = spawnSync("script", ["-q", "/dev/null", "true"], { encoding: "utf8" });
  if (bsd.status === 0) return { ok: true, reason: "bsd script" };
  const why = String(bsd.stderr || probe.stderr || "").trim().split("\n").pop() ?? "";
  return { ok: false, reason: `script cannot allocate a pty here: ${why.slice(0, 120)}` };
}
