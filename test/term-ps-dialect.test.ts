/**
 * `ps -e` is "all processes" on Linux and "show the environment" on BSD/macOS (#macos).
 *
 * Pty discovery falls back to `ps` where `/proc` does not exist — which is every Darwin host — so this argument decided
 * whether a terminal worked at all on macOS. With `-e`, BSD `ps` ignores the field list and prints the environment, so the
 * parse found no pid/ppid/tty rows and discovery returned null: `a script-wrapped shell must expose a pty slave`.
 *
 * `-A` means "all processes" in both dialects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/server/term-size.ts", import.meta.url), "utf8");

test("the fallback asks for every process with the portable flag", () => {
  assert.match(src, /"-A", "-o", "pid=,ppid=,tty="/, "`ps -A` is all-processes on both dialects");
  assert.ok(!/\["-e", "-o"/.test(src), "`-e` means the environment on BSD and would silently return nothing");
});

test("the argument this host would use actually parses into pid/ppid/tty rows", () => {
  // the real thing, on whatever platform is running: the columns must be there and the shape must parse
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,tty="], { encoding: "utf8" });
  const rows = out
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 3 && Number.isInteger(Number(c[0])));
  assert.ok(rows.length > 1, `the output must contain process rows; got ${rows.length}`);
  assert.ok(
    rows.some((r) => r[2] === "?"),
    "and a tty column that says ? when there is no terminal",
  );
});
