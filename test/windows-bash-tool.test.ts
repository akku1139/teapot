/**
 * The `bash` tool must actually RUN on Windows.
 *
 * MEASURED gap: both spawn sites hardcoded `/bin/bash`, so every `bash` tool call on Windows
 * failed with ENOENT. Nothing caught it because the Windows job runs `pnpm test:portable`
 * (181 files), and of those, ZERO execute the bash tool — every test that does is marked
 * `markPosixOnly` and skipped. The breakage was invisible by construction.
 *
 * `tool-shell-platform.test.ts` pins the SELECTION. This file pins the OUTCOME: it really
 * spawns a command and reads its output. That cannot be portable (it needs a working shell), so
 * it is the mirror image — it is meaningful ONLY on Windows and the workflow runs it by name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempInRootSync } from "./helpers/tmp-root.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import { executeTool } from "../src/agent/tools.ts";

const ctx = (cwd: string) => ({ cwd, defaultTimeoutMs: 20_000, maxOutputBytes: 100_000 }) as never;

/** is a POSIX shell reachable? mirrors toolShellFor so the test asks the same question */
function hasBash(): boolean {
  if (process.platform !== "win32") return true;
  const p = process.env.PATH ?? "";
  return p.split(";").some((d) => d && (existsSync(path.join(d, "bash.exe")) || existsSync(path.join(d, "bash"))));
}

test("the bash tool runs a command on this platform (#win)", async () => {
  const ws = mkdtempInRootSync("winsh-");
  const r = await executeTool("bash", JSON.stringify({ command: "echo TEAPOT_SHELL_OK" }), ctx(ws));
  assert.equal(r.ok, true, `the bash tool must work here; got: ${r.result}`);
  assert.match(String(r.result ?? ""), /TEAPOT_SHELL_OK/, "and its stdout must come back");
});

test("the bash tool reports the RIGHT working directory (#win)", async () => {
  /**
   * The reason this matters more on Windows than elsewhere: there is no `/bin/bash`, so the
   * shell is `bash.exe` (Git for Windows, on PATH) or `cmd.exe`. `cmd` does not understand
   * `pwd` — so this also proves the chosen shell can run the command the model actually writes.
   */
  const ws = mkdtempInRootSync("wincwd-");
  // `pwd` in bash, `cd` in cmd (bare `cd` prints the cwd only there; `bash -c cd` prints
  // nothing). Pick per shell so the assertion is about the STARTING DIRECTORY, not about which
  // shell got chosen.
  const cmd = process.platform === "win32" && !hasBash() ? "cd" : "pwd";
  const r = await executeTool("bash", JSON.stringify({ command: cmd }), ctx(ws));
  const out = String(r.result ?? "").replace(/\//g, "\\").toLowerCase();
  assert.ok(
    out.includes(ws.replace(/\//g, "\\").toLowerCase()),
    `the shell must start in the workspace, not somewhere else; got: ${r.result}`,
  );
});

test("a failing command reports failure rather than looking successful (#win)", async () => {
  const ws = mkdtempInRootSync("winfail-");
  const r = await executeTool("bash", JSON.stringify({ command: "exit 3" }), ctx(ws));
  assert.equal(r.ok, false, "a non-zero exit must be reported as a failure");
});
