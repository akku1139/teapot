/**
 * #157 — the two guards from #92's survey that were never implemented.
 *
 * ## Why, in numbers
 *
 * MEASURED across every session (#83):
 *
 *     edit_file     2084 calls   8.1% fail
 *     apply_patch    501 calls  21.8% fail
 *     write_file     934 calls   3.2% fail
 *
 * and of the 168 failures, `old_text not found` was **117**. Plus 10 `matched more than once`.
 * So the dominant failure is the ANCHOR, not the edit — which is what both guards address.
 *
 * ## The two
 *
 * 1. **Disproportionate match** (OpenCode's `isDisproportionateMatch`, the only such guard
 *    found in the survey). The dangerous shape is not "no match" — that is loud and
 *    recoverable — but a match far LARGER than the anchor, where asking to change one call
 *    site rewrites a whole function. A confident wrong edit is worse than a failed one.
 *
 * 2. **Minimum anchor length** (Gemini's 10-character floor). Below that an anchor cannot
 *    identify anything, so relaxing the match on it can only find the wrong span. A SHORT
 *    anchor that matches exactly once is still accepted — a one-character edit is legitimate;
 *    what is refused is trying to make a short anchor work by loosening the comparison.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { useTempDir } from "./helpers/tmp.ts";
import { disproportionateSpan, executeTool } from "../src/agent/tools.ts";

const ctx = (cwd: string) => ({ cwd, defaultTimeoutMs: 5000, maxOutputBytes: 100_000 }) as never;

test("a disproportionate span is REFUSED, and the reason names the size (#157)", () => {
  // the shape that bites: a short anchor whose lines only line up after skipping many file
  // lines. Applying it would replace a region the model never pointed at.
  const file = ["a", "b", "NOISE1", "NOISE2", "NOISE3", "NOISE4", "NOISE5", "target"].join("\n");
  const anchor = "a\ntarget"; // 2 lines, but 8 lines apart in the file
  const why = disproportionateSpan(file, anchor);
  assert.ok(why, "an anchor whose lines are far apart must be refused");
  assert.match(why!, /2 line\(s\)/, "the refusal must state what was asked for");
  assert.match(why!, /8 lines|covering \d+/, "…and how far it actually reached");
  assert.match(why!, /tighter block/, "…and what to do instead");
});

test("an ordinary multi-line anchor is NOT refused (#157)", () => {
  // the guard must not make normal editing harder — this is the common case
  const file = "function f() {\n  a();\n  b();\n}\n";
  assert.equal(disproportionateSpan(file, "function f() {\n  a();"), null);
  assert.equal(disproportionateSpan(file, "  a();\n  b();"), null);
  // a single-line anchor cannot span disproportionately at all
  assert.equal(disproportionateSpan(file, "  a();"), null);
  // an exact match that does not need to skip anything is fine
  assert.equal(disproportionateSpan(file, "function f() {\n  a();\n  b();\n}"), null);
});

test("a sub-floor anchor is not rescued by trailing-whitespace tolerance (#157)", async () => {
  await useTempDir("short3-", async (ws) => {
    /**
     * The floor gates the TOLERANT matcher only, so the anchor must be absent VERBATIM while
     * still having exactly one tolerant hit. Trailing whitespace on the ANCHOR (not the file)
     * does that: `"foo();  "` is not a substring of `"foo();"`, but `.trimEnd()` makes them
     * equal. Three earlier fixtures failed this precondition and passed with the floor removed.
     */
    const src = "a();\nfoo();\nb();\n";
    await writeFile(`${ws}/f.js`, src, "utf8");
    const anchor = "foo();  "; // 8 chars incl. padding — under the floor
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
    // a one-character edit is legitimate; the floor only forbids FUZZY matching on short
    // anchors, so an exact unique match must still apply
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
    /**
     * MEASURED while adding the floor: applying it by raw character count broke a legitimate
     * case already covered elsewhere — `"foo\nbar"` is 7 characters, so the tolerant path was
     * refused, and a test that had worked for months failed.
     *
     * The floor exists because a SINGLE line like "  }" or "foo();" cannot identify anything.
     * Two matching lines pin a start AND a continuation, which is far stronger evidence. A guard
     * that makes ordinary edits fail is the exact failure #157 warns about.
     */
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
