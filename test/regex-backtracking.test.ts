/**
 * #93 — a model-supplied regex could hang the agent.
 *
 * `(a+)+b` against 28 characters of "a" took **3.8 seconds**, roughly doubling
 * per character added; a 40-character line would run for days. There is no
 * timeout on that path — `ctx.defaultTimeoutMs` guards `bash` only, so the scan
 * is a synchronous `re.test(line)` with nothing able to interrupt it. The agent
 * process blocks and takes the UI and every other agent with it.
 *
 * A model is poorly placed to reason about backtracking cost and nothing tells it
 * not to try, so the PATTERN is rejected rather than the runtime bounded: a
 * synchronous regex cannot be abandoned once `test` starts, so the only reliable
 * protection is never to compile one.
 *
 * The over-rejection matters as much as the rejection. An earlier version
 * refused ANY quantified alternation, which killed `(foo|bar)+baz` — an ordinary
 * pattern. It now fires only on identical branches, which is the shape that
 * actually explodes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempDirs } from "./helpers/tmp.ts";
import { executeTool } from "../src/agent/tools.ts";

/** run the real tool so this is behavioural, not a regex-over-source check */
async function grep(ws: string, pattern: string): Promise<{ ok: boolean; result: string }> {
  const r = await executeTool(
    "read_file",
    JSON.stringify({ path: "f.txt", pattern }),
    { cwd: ws, defaultTimeoutMs: 5000, maxOutputBytes: 10_000 } as never,
  );
  return { ok: r.ok, result: String(r.result ?? "") };
}

/** a file with enough `a` for the payload to matter, and real text too */
async function fixture(ws: string, body = "a".repeat(200) + "\nfoo bar\n") {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${ws}/f.txt`, body, "utf8");
}

/* ---------- the payloads that hung ---------- */

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

/* ---------- and it must not over-reject ---------- */

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
  // the over-rejection this file exists to prevent: (foo|bar)+ cannot backtrack
  // because the branches cannot both match the same text
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

/* ---------- bounds ---------- */

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
