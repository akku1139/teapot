import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { executeTool } from "../src/agent/tools.ts";

async function grep(ws: string, pattern: string): Promise<{ ok: boolean; result: string }> {
  const r = await executeTool(
    "read_file",
    JSON.stringify({ path: "f.txt", pattern }),
    { cwd: ws, defaultTimeoutMs: 5000, maxOutputBytes: 10_000 } as never,
  );
  return { ok: r.ok, result: String(r.result ?? "") };
}

async function fixture(ws: string, body = "a".repeat(200) + "\nfoo bar\n") {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${ws}/f.txt`, body, "utf8");
}

test("(a+)+b is refused, and instantly (#93)", async () => {
  await useTempDirs(["bt1-", "bt2-"], async ([ws, _sd]) => {
    await fixture(ws!);
    const t0 = Date.now();
    const r = await grep(ws!, "(a+)+b");
    assert.equal(r.ok, false, "the payload must be refused (#93)");
    assert.ok(Date.now() - t0 < 1000, `must be instant, not slow (#93); took ${Date.now() - t0}ms`);
  });
});

test("the other catastrophic shapes are refused (#93)", async () => {
  await useTempDirs(["bt3-", "bt4-"], async ([ws, _sd]) => {
    await fixture(ws!);
    for (const p of ["(a+)+b", "(a*)*c", "(a+)*b", "(.*)+x", "(.+)*y", "(a|a)+b", "(a|a)*c"]) {
      const r = await grep(ws!, p);
      assert.equal(r.ok, false, `${p} must be refused (#93)`);
      assert.match(r.result, /backtrack|rejected/i, `${p} must say why (#93)`);
    }
  });
});

test("ordinary quantifiers still work (#93)", async () => {
  await useTempDirs(["bt5-", "bt6-"], async ([ws, _sd]) => {
    await fixture(ws!);
    for (const p of ["a+b", "[0-9]+", "^a{2,}$", "needle", "foo|bar", "(ab)+c", "\\d{3}"]) {
      const r = await grep(ws!, p);
      assert.equal(r.ok, true, `${p} is an ordinary pattern and must work (#93): ${r.result}`);
    }
  });
});

test("a quantified alternation with DISTINCT branches still works (#93)", async () => {
  await useTempDirs(["bt7-", "bt8-"], async ([ws, _sd]) => {
    await fixture(ws!);
    for (const p of ["(foo|bar)+baz", "(cat|dog)s?", "^(foo|bar)$"]) {
      const r = await grep(ws!, p);
      assert.equal(r.ok, true, `${p} must not be refused (#93): ${r.result}`);
    }
  });
});

test("the message names the cost, so the model can adapt (#93)", async () => {
  await useTempDirs(["bt9-", "bt10-"], async ([ws, _sd]) => {
    await fixture(ws!);
    const r = await grep(ws!, "(a+)+b");
    assert.match(r.result, /3\.8s|freeze/i, "must explain why (#93)");
    assert.match(r.result, /literal|literal search|simplify/i, "and suggest an alternative (#93)");
  });
});

test("an absurdly long pattern is refused (#93)", async () => {
  await useTempDirs(["bt11-", "bt12-"], async ([ws, _sd]) => {
    await fixture(ws!);
    const r = await grep(ws!, "a".repeat(2000));
    assert.equal(r.ok, false, "a 2000-char pattern must be refused (#93)");
    assert.match(r.result, /too long/i, "and say so (#93)");
  });
});

test("read_file without a pattern is unaffected (#93)", async () => {
  await useTempDirs(["bt13-", "bt14-"], async ([ws, _sd]) => {
    await fixture(ws!);
    const r = await executeTool(
      "read_file",
      JSON.stringify({ path: "f.txt" }),
      { cwd: ws!, defaultTimeoutMs: 5000, maxOutputBytes: 10_000 } as never,
    );
    assert.equal(r.ok, true, "the normal read path must be untouched (#93)");
  });
});
