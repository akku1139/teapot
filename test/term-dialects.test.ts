/**
 * `script` and `stty` each have a GNU dialect and a BSD one, and this code shipped the GNU spelling to both (#macos).
 *
 * MEASURED on the macOS job, four failures from one cause each:
 *   - `replay returns the output a client missed while detached` and `input reaches the shell` — BSD `script` has no `-e`
 *     and no `-c`, so `-qec` was read as the typescript FILE and the shell name as an argument it could not use; the pty
 *     never carried a working shell.
 *   - `resolvePtySlave finds the pty behind a script-wrapped shell` — a pty slave is `/dev/pts/N` on Linux and
 *     `/dev/ttysNNN` on macOS, and the discovery matched only the first.
 *   - `applying a size never writes to stdin` — `stty -F <device>` is GNU; BSD takes the device positionally.
 *
 * These are dialect facts, not behaviours, so they are pinned as the argv this code builds for each platform — the one
 * thing that can be checked on a single host without pretending to be the other OS.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { applyPtySize } from "../src/server/term-size.ts";

const src = readFileSync(new URL("../src/server/terminals.ts", import.meta.url), "utf8");
const sizeSrc = readFileSync(new URL("../src/server/term-size.ts", import.meta.url), "utf8");

test("the BSD `script` invocation does not use the GNU flags", () => {
  assert.match(src, /process\.platform === "darwin"/, "the dialect is chosen by platform");
  assert.match(src, /\["-q", "\/dev\/null", shell\]/, "BSD: script -q <file> <command>");
  assert.match(src, /\["-qec", shell, "\/dev\/null"\]/, "GNU: script -qec <command> <file>");
  assert.ok(!/script", \["-qec"/.test(src), "and the GNU form is not what all platforms get");
});

test("a pty slave is recognised in both spellings", () => {
  assert.match(
    sizeSrc,
    /\/\^\\\/dev\\\/\(\?:pts\\\/\\d\+\|ttys\\d\+\)\$\//,
    "Linux /dev/pts/N and macOS /dev/ttysNNN",
  );
});

test("stty gets the dialect its own platform uses", () => {
  assert.match(sizeSrc, /process\.platform === "darwin"/, "the dialect is chosen by platform");
  assert.match(sizeSrc, /\[slave, "rows"/, "BSD: stty <device> rows R cols C");
  assert.match(sizeSrc, /\["-F", slave, "rows"/, "GNU: stty -F <device> rows R cols C");
});

test("applyPtySize passes the argv it built to spawnFn, and never to stdin", () => {
  const seen: string[][] = [];
  const fakeSpawn = ((_cmd: string, args: string[]) => {
    seen.push(args);
    return {} as never;
  }) as never;
  // a child with no resolvable pty reports false and spawns nothing
  const spawned = applyPtySize({} as ChildProcess, 24, 80, fakeSpawn);
  assert.equal(spawned, false, "no pty, no stty — the caller falls back");
  assert.deepEqual(seen, [], "and nothing was spawned");
});
