import { test } from "node:test";
import assert from "node:assert/strict";
import { toolShellFor } from "../src/agent/tools.ts";
import { terminalShellFor } from "../src/server/terminals.ts";

test("POSIX runs a real POSIX shell (#win)", () => {
  const spec = toolShellFor("linux", { SHELL: "/bin/zsh" });
  assert.equal(spec.file, "/bin/zsh", "$SHELL wins when set");
  assert.deepEqual(spec.args("echo hi"), ["-c", "echo hi"]);

  assert.equal(toolShellFor("linux", {}).file, "/bin/bash");
  assert.equal(toolShellFor("darwin", {}).file, "/bin/bash");
});

test("Windows never chooses a POSIX path, and prefers bash when present (#win)", () => {
  for (const spec of [
    toolShellFor("win32", { COMSPEC: "C:\\Windows\\system32\\cmd.exe" }),
    toolShellFor("win32", {}),
  ]) {
    assert.doesNotMatch(spec.file, /^\//, "a Windows shell must not be a POSIX absolute path");
  }

  const withBash = toolShellFor("win32", { PATH: "C:\\Program Files\\Git\\bin;C:\\Windows" }, (p) =>
    /Git/i.test(p),
  );
  assert.equal(withBash.file, "bash");
  assert.deepEqual(withBash.args("echo hi"), ["-c", "echo hi"]);

  const bare = toolShellFor("win32", { COMSPEC: "C:\\Windows\\system32\\cmd.exe" }, () => false);
  assert.equal(bare.file, "C:\\Windows\\system32\\cmd.exe");
  assert.deepEqual(bare.args("dir"), ["/d", "/s", "/c", "dir"], "cmd needs /d /s /c");
});

test("an explicit TEAPOT_SHELL overrides everything (#win)", () => {
  assert.equal(toolShellFor("linux", { TEAPOT_SHELL: "/usr/bin/fish", SHELL: "/bin/bash" }).file, "/usr/bin/fish");
  assert.equal(toolShellFor("win32", { TEAPOT_SHELL: "pwsh.exe" }).file, "pwsh.exe");
});

test("a POSIX $SHELL is never used on Windows (#win)", async () => {
  const winEnv = {
    SHELL: "/usr/bin/bash",
    COMSPEC: "C:\\Windows\\system32\\cmd.exe",
    PATH: "C:\\Windows\\system32",
  } as NodeJS.ProcessEnv;
  const picked = toolShellFor("win32", winEnv, () => false);
  assert.ok(
    !picked.file.startsWith("/"),
    `a Windows shell must not be a POSIX path; got ${picked.file}`,
  );
  assert.equal(picked.file, "C:\\Windows\\system32\\cmd.exe", "falls back to %COMSPEC%");

  const forced = toolShellFor("win32", { ...winEnv, TEAPOT_SHELL: "pwsh" }, () => false);
  assert.equal(forced.file, "pwsh");
});

test("the TERMINAL ignores a POSIX $SHELL on Windows too (#win)", async () => {
  const winEnv = {
    SHELL: "/usr/bin/bash",
    COMSPEC: "C:\\Windows\\system32\\cmd.exe",
    PATH: "C:\\Windows\\system32",
  } as NodeJS.ProcessEnv;
  const picked = terminalShellFor("win32", winEnv, () => false);
  assert.ok(
    !picked.startsWith("/"),
    `a terminal on Windows must not spawn a POSIX path; got ${picked}`,
  );
  assert.equal(picked, "C:\\Windows\\system32\\cmd.exe");

  const withGit = terminalShellFor("win32", { ...winEnv, PATH: "C:\\Program Files\\Git\\bin" }, (p) =>
    p.endsWith("bash.exe"),
  );
  assert.equal(withGit, "bash");

  assert.equal(terminalShellFor("linux", { SHELL: "/usr/bin/zsh" } as NodeJS.ProcessEnv), "/usr/bin/zsh");
  assert.equal(terminalShellFor("linux", {} as NodeJS.ProcessEnv), "/bin/bash");
});
