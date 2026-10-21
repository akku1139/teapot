/**
 * The `bash` tool must pick a shell that EXISTS on this platform.
 *
 * Reported as a Windows gap: both spawn sites hardcoded `/bin/bash`, which on Windows is ENOENT —
 * the tool was entirely unavailable on a platform this package claims to support.
 *
 * ## Why Windows CI did not catch it
 *
 * MEASURED: the Windows job runs `pnpm test:portable`, which is 181 files; 35 are marked
 * `markPosixOnly` and skipped. Every test that actually EXECUTES the bash tool is in the skipped
 * set, so no portable test ever spawned a shell. The gap was invisible by construction, not by
 * luck.
 *
 * So this file is written to be portable: it asserts the SELECTION, which is pure, rather than
 * running a command. It passes on Windows and on POSIX alike.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolShellFor } from "../src/agent/tools.ts";

test("POSIX runs a real POSIX shell (#win)", () => {
  const spec = toolShellFor("linux", { SHELL: "/bin/zsh" });
  assert.equal(spec.file, "/bin/zsh", "$SHELL wins when set");
  assert.deepEqual(spec.args("echo hi"), ["-c", "echo hi"]);

  // no $SHELL: fall back to bash, which every POSIX target has
  assert.equal(toolShellFor("linux", {}).file, "/bin/bash");
  assert.equal(toolShellFor("darwin", {}).file, "/bin/bash");
});

test("Windows never chooses a POSIX path, and prefers bash when present (#win)", () => {
  // the bug: `/bin/bash` was chosen unconditionally, so every call was ENOENT
  for (const spec of [
    toolShellFor("win32", { COMSPEC: "C:\\Windows\\system32\\cmd.exe" }),
    toolShellFor("win32", {}),
  ]) {
    assert.doesNotMatch(spec.file, /^\//, "a Windows shell must not be a POSIX absolute path");
  }

  // with bash on PATH (Git for Windows — what the CI runner has) use it, because teapot's tool
  // commands are POSIX idioms: &&, $VAR, single quotes
  const withBash = toolShellFor("win32", { PATH: "C:\\Program Files\\Git\\bin;C:\\Windows" }, (p) =>
    /Git/i.test(p),
  );
  assert.equal(withBash.file, "bash");
  assert.deepEqual(withBash.args("echo hi"), ["-c", "echo hi"]);

  // …and with no bash at all, cmd.exe keeps the tool WORKING rather than failing outright
  const bare = toolShellFor("win32", { COMSPEC: "C:\\Windows\\system32\\cmd.exe" }, () => false);
  assert.equal(bare.file, "C:\\Windows\\system32\\cmd.exe");
  assert.deepEqual(bare.args("dir"), ["/d", "/s", "/c", "dir"], "cmd needs /d /s /c");
});

test("an explicit TEAPOT_SHELL overrides everything (#win)", () => {
  assert.equal(toolShellFor("linux", { TEAPOT_SHELL: "/usr/bin/fish", SHELL: "/bin/bash" }).file, "/usr/bin/fish");
  assert.equal(toolShellFor("win32", { TEAPOT_SHELL: "pwsh.exe" }).file, "pwsh.exe");
});
