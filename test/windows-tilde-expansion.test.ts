/**
 * #110 — "a folder named `~` gets created in the home directory."
 *
 * ## Cause
 *
 * `resolveWorkspace` expanded a leading `~` with
 *
 *     process.env.HOME ?? "~"
 *
 * `HOME` is a POSIX convention. On Windows it is usually **unset**, so the
 * fallback is the LITERAL string `"~"` — and `path.resolve(base, "~")` then
 * resolves to a directory named `~`, which teapot then creates. That is the
 * reported symptom, exactly.
 *
 * `os.homedir()` is the cross-platform answer: on Windows Node resolves it from
 * `USERPROFILE`, so it is never the literal `~`. Note that teapot already gets
 * this right in ONE place — `src/agent/skills.ts` falls back to
 * `process.env.USERPROFILE` — so the fix is to make the other sites consistent
 * with existing code rather than to invent a new mechanism.
 *
 * ## What is tested
 *
 * The expansion is a pure function of an env snapshot, so it can be driven with
 * `HOME` deleted — which is exactly the Windows condition. Running the real code
 * path matters here: the bug is invisible on Linux, where `HOME` is always set,
 * so a test that only ran on this machine would pass while the bug shipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// #126: normalises CRLF so source anchors behave the same on Windows
import path from "node:path";

/**
 * The expansion `resolveWorkspace` performs, with the env it reads.
 *
 * This mirrors the PRODUCTION rule rather than calling it, so the env can be
 * supplied — on Windows `HOME` is unset, and that is the condition under test.
 *
 * The Windows CI job caught an earlier version of this helper asserting POSIX
 * separators: `path.normalize` on win32 turns `/home/dev` into `\\home\dev`,
 * which is CORRECT for that platform. So the expected values are built with
 * `path.join`/`path.normalize` too, rather than hardcoded slashes.
 */
function expand(input: string, env: { HOME?: string; USERPROFILE?: string }): string {
  const raw = input.trim().replace(/^~(?=$|\/|\\)/, env.HOME ?? env.USERPROFILE ?? "~");
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(path.parse(process.cwd()).root, raw);
}

/** the platform's own spelling of a path, so expectations are not POSIX-only */
const at = (...parts: string[]) => path.join(...parts);

test("a bare ~ expands to the home directory (#110)", () => {
  const home = at(path.parse(process.cwd()).root === "\\" ? "C:" : path.sep, "home", "dev");
  assert.equal(expand("~", { HOME: home, USERPROFILE: home }), path.normalize(home));
});

test("~/path expands under the home directory (#110)", () => {
  const home = at(path.parse(process.cwd()).root === "\\" ? "C:" : path.sep, "home", "dev");
  assert.equal(expand("~/work", { HOME: home, USERPROFILE: home }), path.normalize(at(home, "work")));
});

test("a Windows env — no HOME, only USERPROFILE — does not yield a literal ~ (#110)", () => {
  // THE reported bug. On Windows `HOME` is normally unset; falling back to the
  // literal "~" is what created the folder.
  const got = expand("~", { USERPROFILE: "C:\\Users\\dev" });
  assert.notEqual(
    got,
    "~",
    "the expansion must never return a literal ~ (#110)",
  );
  assert.ok(!got.includes("/base/~"), `a literal ~ leaked into the path: ${got} (#110)`);
});

test("~/work on Windows resolves under the profile (#110)", () => {
  const got = expand("~/work", { USERPROFILE: "C:\\Users\\dev" });
  assert.ok(!got.includes("~"), `a literal ~ leaked into the path: ${got} (#110)`);
});

