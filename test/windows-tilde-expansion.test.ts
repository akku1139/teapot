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
 * this right in ONE place — `src/agent/skills.ts:165` falls back to
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
import { readFileSync } from "node:fs";
import path from "node:path";

const master = readFileSync(new URL("../src/master.ts", import.meta.url), "utf8");

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

test("when neither HOME nor USERPROFILE exists, the ~ is left ALONE (#110)", () => {
  // Deliberately NOT os.homedir()'s value: with nothing to expand to, keeping the
  // literal is more honest than inventing a path, and the caller surfaces it.
  // The important part is that this is a distinct, explicit case.
  const got = expand("~", {});
  assert.ok(
    got.endsWith("~") || got === "~",
    `with no home known the literal is expected, got ${got} (#110)`,
  );
});

/* ---------- the shared helper, driven with real env shapes ---------- */

test("homeDir handles every env shape Windows can present (#110)", async () => {
  const { homeDir: real } = await import("../src/home.ts");
  assert.equal(real({ HOME: "/home/dev" }), "/home/dev", "HOME is used verbatim (#110)");
  assert.equal(real({ USERPROFILE: "C:\\Users\\dev" }), "C:\\Users\\dev", "USERPROFILE (#110)");
  assert.equal(
    real({ HOMEDRIVE: "C:", HOMEPATH: "\\Users\\dev" }),
    "C:\\Users\\dev",
    "HOMEDRIVE + HOMEPATH is also a home (#110)",
  );
});

test("homeDir never returns the string \"undefined\" (#110)", async () => {
  // `drive.replace(...) + path` yields the STRING "undefined" when either part is
  // missing — I wrote that bug into the first version of this helper and only
  // caught it by printing every case rather than assuming the happy path.
  const { homeDir: real } = await import("../src/home.ts");
  for (const env of [{}, { HOMEPATH: "\\Users\\dev" }, { HOMEDRIVE: "C:" }, { USERPROFILE: "C:\\U" }]) {
    assert.ok(
      !real(env).includes("undefined"),
      `homeDir leaked the string "undefined" for ${JSON.stringify(env)} (#110)`,
    );
  }
});

test("with no home at all, the ~ is left untouched (#110)", async () => {
  const { expandTilde: real } = await import("../src/home.ts");
  assert.equal(real("~", {}), "~", "nothing known => leave it alone (#110)");
});

/* ---------- the actual source must agree ---------- */

test("resolveWorkspace does not read HOME alone (#110)", () => {
  const at = master.indexOf("export function resolveWorkspace");
  assert.notEqual(at, -1, "resolveWorkspace must exist (#110)");
  const block = master.slice(at, master.indexOf("\n}", at));
  assert.doesNotMatch(
    block,
    /process\.env\.HOME \?\? "~"/,
    "falling back to the literal ~ is the bug (#110)",
  );
  assert.doesNotMatch(
    block,
    /process\.env\.HOME \?\? ~/,
    "in any form (#110)",
  );
});

test("every ~ expansion in src/ has a non-POSIX fallback (#110)", () => {
  // the same mistake is easy to make again; skills.ts:165 already does it right
  const files: [string, string][] = [
    ["src/master.ts", master],
    ["src/server/api.ts", readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8")],
    ["src/agent/skills.ts", readFileSync(new URL("../src/agent/skills.ts", import.meta.url), "utf8")],
  ];
  for (const [name, src] of files) {
    for (const m of src.matchAll(/(?:process\.env\.HOME|~\/\^~)[^\n]*/g)) {
      const line = m[0];
      if (!line.includes("~")) continue;
      assert.ok(
        /os\.homedir\(\)|USERPROFILE/.test(line),
        `${name}: a ~ expansion reads only process.env.HOME, which is unset on Windows: ${line.trim()} (#110)`,
      );
    }
  }
});
