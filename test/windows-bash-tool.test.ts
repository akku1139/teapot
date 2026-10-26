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

test("the bash tool runs a command on this platform (#win)", async () => {
  const ws = mkdtempInRootSync("winsh-");
  const r = await executeTool("bash", JSON.stringify({ command: "echo TEAPOT_SHELL_OK" }), ctx(ws));
  assert.equal(r.ok, true, `the bash tool must work here; got: ${r.result}`);
  assert.match(String(r.result ?? ""), /TEAPOT_SHELL_OK/, "and its stdout must come back");
});

test("the bash tool reports the RIGHT working directory (#win)", async () => {
  /**
   * The reason this matters more on Windows than elsewhere: there is no `/bin/bash`, so the shell
   * is `bash.exe` (Git for Windows, on PATH) or `cmd.exe` — and the two print a cwd in different
   * forms. MEASURED on the Windows runner: comparing `pwd`'s OUTPUT against the workspace string
   * failed while the shell had in fact run in the right place, because Git Bash's `/tmp` mount and
   * Node's `C:\\tmp` name the same directory differently.
   *
   * So assert the INVARIANT, not the spelling: have the shell create a file, then check it is
   * where the workspace says it should be. That is the thing callers depend on — a command must
   * see the workspace's files — and it is representation-independent.
   */
  const ws = mkdtempInRootSync("wincwd-");
  const probe = "teapot-cwd-probe.txt";
  const r = await executeTool(
    "bash",
    JSON.stringify({ command: `echo OK > ${probe}` }),
    ctx(ws),
  );
  assert.equal(r.ok, true, `writing into the workspace must work; got: ${r.result}`);
  const landed = path.join(ws, probe);
  assert.ok(
    existsSync(landed),
    `the shell must start in the workspace: expected the file at ${landed}, and the command said ${JSON.stringify(r.result)}`,
  );
});

test("a failing command reports failure rather than looking successful (#win)", async () => {
  const ws = mkdtempInRootSync("winfail-");
  const r = await executeTool("bash", JSON.stringify({ command: "exit 3" }), ctx(ws));
  assert.equal(r.ok, false, "a non-zero exit must be reported as a failure");
});
