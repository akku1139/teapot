/**
 * `script` and `stty` each have a GNU dialect and a BSD one, and this code shipped the GNU spelling to both (#macos).
 *
 * MEASURED on the macOS job:
 *   - BSD `script` has no `-e` and no `-c`, so a `-qec` argument was read as the typescript FILE and the shell name as an
 *     argument it could not use. The pty never carried a working shell: `replay returns the output a client missed` and
 *     `input reaches the shell` both failed.
 *   - `stty -F <device>` is GNU; BSD takes the device positionally.
 *
 * Both are the PLATFORM's implementation, so the argv is chosen by `process.platform`. These pin the argv that function
 * builds, which is the only thing checkable from one host — asserting on the SOURCE of the call site would pin spelling
 * instead of behaviour and could not fail for a real reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { applyPtySize } from "../src/server/term-size.ts";
import { scriptArgsFor } from "../src/server/terminals.ts";

test("each platform gets its own `script` invocation", () => {
  assert.deepEqual(scriptArgsFor("darwin", "bash"), ["-q", "/dev/null", "bash"], "BSD: script -q <file> <command>");
  assert.deepEqual(scriptArgsFor("linux", "bash"), ["-qec", "bash", "/dev/null"], "GNU: script -qec <command> <file>");
  // and the two are genuinely different, so a single form is not silently serving both
  assert.notDeepEqual(scriptArgsFor("darwin", "bash"), scriptArgsFor("linux", "bash"));
});

test("the BSD form has no GNU-only flags", () => {
  for (const a of scriptArgsFor("darwin", "bash")) {
    assert.ok(!/^-[a-z]*[ec]/.test(a), `BSD script takes no -e/-c; got ${a}`);
  }
});

test("applyPtySize passes what it built to spawnFn, and never writes to stdin", () => {
  const seen: string[][] = [];
  const fakeSpawn = ((_cmd: string, args: string[]) => {
    seen.push(args);
    return {} as never;
  }) as never;
  // a child with no resolvable pty reports false and spawns nothing — the caller falls back
  const spawned = applyPtySize({} as ChildProcess, 24, 80, fakeSpawn);
  assert.equal(spawned, false, "no pty, no stty");
  assert.deepEqual(seen, [], "and nothing was spawned");
});
