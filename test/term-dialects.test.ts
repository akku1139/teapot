/**
 * `script` has two incompatible argv dialects, and this code shipped the GNU one to both (#macos).
 *
 * BSD/macOS: `script [-q] [file [command ...]]` — no `-c`, no `-e` (Apple's `script.c` accepts `-e` as a no-op "for linux
 * compat"). GNU: `script -qec '<command line>' <file>`, with the command line as ONE string.
 *
 * The dialect is NOT chosen from `process.platform`: a GNU `script` can be installed on a Darwin host and a BSD one on
 * Linux, and the two forms are mutually exclusive. It is probed once per process by asking each `script` about an option it
 * does not have and reading the stderr.
 *
 * These pin the argv built for each dialect (behaviour) rather than matching the source of the call site (spelling, which
 * could not fail for a real reason).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { scriptArgsFor, scriptDialect } from "../src/server/terminals.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// `script` is a POSIX tool; Windows has neither it nor these dialects.
markPosixOnly("pins the argv dialects of script(1)");

test("each dialect gets its own `script` invocation", () => {
  assert.deepEqual(scriptArgsFor("bsd", "bash"), ["-q", "/dev/null", "bash"], "BSD: script -q <file> <command>");
  assert.deepEqual(scriptArgsFor("gnu", "bash"), ["-qec", "bash", "/dev/null"], "GNU: script -qec <command> <file>");
  // and the two are genuinely different, so a single form is not silently serving both
  assert.notDeepEqual(scriptArgsFor("bsd", "bash"), scriptArgsFor("gnu", "bash"));
});

test("BSD takes the program and its arguments as SEPARATE argv", () => {
  assert.deepEqual(
    scriptArgsFor("bsd", "sleep", ["5"]),
    ["-q", "/dev/null", "sleep", "5"],
    "a single `'sleep 5'` would exec a program with a space in its name",
  );
  assert.deepEqual(
    scriptArgsFor("gnu", "sleep", ["5"]),
    ["-qec", "sleep 5", "/dev/null"],
    "GNU takes the whole command line as one string",
  );
});

test("the BSD form has no GNU-only flags", () => {
  for (const a of scriptArgsFor("bsd", "bash")) {
    assert.ok(!/^-[a-z]*[ec]/.test(a), `BSD script takes no -e/-c; got ${a}`);
  }
});

test("the dialect is decided by TRYING, not by the platform name", () => {
  /**
   * A GNU `script` can be installed on a Darwin host and a BSD one on Linux, and the two argv forms are mutually exclusive.
   * Guessing from `process.platform` is what left the macOS job with `script` exiting 1 and no pty behind it.
   */
  assert.ok(["gnu", "bsd", null].includes(scriptDialect()), "this host's answer is one of the three");
});

test("the probe asks about the ARGV, not about whether a pty can be opened here", () => {
  /**
   * MEASURED on the macOS job: a probe that actually RAN the two forms answered "bsd" while BOTH failed for a different
   * reason — `tcgetattr/ioctl: Operation not supported on socket`, because BSD `script` checks stdin and a Node
   * `stdio: "pipe"` is a socketpair. A probe that opens a pty answers "can this process run script"; the product needs
   * "does this script understand this argv".
   *
   * The fakes below are the two real `script`s quoting their own stderr for an option they do not know.
   */
  const bsdOnly = ((_cmd: string, args: string[]) => ({
    status: 1,
    stderr:
      args[0] === "-c"
        ? "script: illegal option -- c\nusage: script [-aeFkpqr] [-t time] [file [command ...]]\n"
        : "",
  })) as never;
  const gnuOnly = ((_cmd: string, args: string[]) => ({
    status: 1,
    stderr: args.includes("--definitely-not-an-option") ? "script: unrecognized option '--definitely-not-an-option'\n" : "",
  })) as never;

  assert.equal(scriptDialect(bsdOnly, { fresh: true }), "bsd", "`illegal option -- c` means BSD");
  assert.equal(scriptDialect(gnuOnly, { fresh: true }), "gnu", "an unrecognized long option means GNU");
});
