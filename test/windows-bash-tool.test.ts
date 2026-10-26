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
