import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

function expand(input: string, env: { HOME?: string; USERPROFILE?: string }): string {
  const raw = input.trim().replace(/^~(?=$|\/|\\)/, env.HOME ?? env.USERPROFILE ?? "~");
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(path.parse(process.cwd()).root, raw);
}

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

