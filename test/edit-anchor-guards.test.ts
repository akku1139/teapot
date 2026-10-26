import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { useTempDir } from "./helpers/tmp.ts";
import { disproportionateSpan, executeTool } from "../src/agent/tools.ts";

const ctx = (cwd: string) => ({ cwd, defaultTimeoutMs: 5000, maxOutputBytes: 100_000 }) as never;

test("a disproportionate span is REFUSED, and the reason names the size (#157)", () => {
  const file = ["a", "b", "NOISE1", "NOISE2", "NOISE3", "NOISE4", "NOISE5", "target"].join("\n");
  const anchor = "a\ntarget"; 
  const why = disproportionateSpan(file, anchor);
  assert.ok(why, "an anchor whose lines are far apart must be refused");
  assert.match(why!, /2 line\(s\)/, "the refusal must state what was asked for");
  assert.match(why!, /8 lines|covering \d+/, "…and how far it actually reached");
  assert.match(why!, /tighter block/, "…and what to do instead");
});

test("an ordinary multi-line anchor is NOT refused (#157)", () => {
  const file = "function f() {\n  a();\n  b();\n}\n";
  assert.equal(disproportionateSpan(file, "function f() {\n  a();"), null);
  assert.equal(disproportionateSpan(file, "  a();\n  b();"), null);
  assert.equal(disproportionateSpan(file, "  a();"), null);
  assert.equal(disproportionateSpan(file, "function f() {\n  a();\n  b();\n}"), null);
});

test("a sub-floor anchor is not rescued by trailing-whitespace tolerance (#157)", async () => {
  await useTempDir("short3-", async (ws) => {
    const src = "a();\nfoo();\nb();\n";
    await writeFile(`${ws}/f.js`, src, "utf8");
    const anchor = "foo();  "; 
    const r = await executeTool(
      "edit_file",
      JSON.stringify({ path: "f.js", old_text: anchor, new_text: "bar();" }),
      ctx(ws),
    );
    assert.ok(!src.includes(anchor), "fixture: the anchor must not be an exact substring");
    assert.ok(anchor.trim().length < 10, "fixture: the anchor must be under the floor");
    assert.equal(r.ok, false, "a sub-floor anchor must not be resolved by tolerance");
    assert.equal(await readFile(`${ws}/f.js`, "utf8"), src, "the file must be untouched");
  });
});

test("a short anchor that IS unique still works (#157)", async () => {
  await useTempDir("short2-", async (ws) => {
    const src = "const a = 1;\nconst b = 2;\n";
    await writeFile(`${ws}/f.ts`, src, "utf8");
    const r = await executeTool(
      "edit_file",
      JSON.stringify({ path: "f.ts", old_text: "= 2", new_text: "= 3" }),
      ctx(ws),
    );
    assert.equal(r.ok, true, "an exact unique short anchor must still be accepted");
    assert.equal(await readFile(`${ws}/f.ts`, "utf8"), "const a = 1;\nconst b = 3;\n");
  });
});

test("a MULTI-LINE anchor is specific enough, whatever its character count (#157)", async () => {
  await useTempDir("ml-", async (ws) => {
    const src = "foo   \nbar\n";
    await writeFile(`${ws}/ws.txt`, src, "utf8");
    const r = await executeTool(
      "edit_file",
      JSON.stringify({ path: "ws.txt", old_text: "foo\nbar", new_text: "baz\nqux" }),
      ctx(ws),
    );
    assert.equal(r.ok, true, "a 2-line anchor must still be allowed to use tolerance");
    assert.match(r.result ?? "", /trailing whitespace/, "and must say it used tolerance");
    assert.equal(await readFile(`${ws}/ws.txt`, "utf8"), "baz\nqux\n");
  });
});
