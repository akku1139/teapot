/**
 * #17 — "the harness deterministically does what a model does badly".
 *
 * Took the A-rank item 1 from that issue: a single shared repair/normalise layer
 * for every tool call. Before this, teapot repaired only tool NAMES and then did
 * a bare JSON.parse in executeTool, so a model sending {"cmd":"ls"} or
 * {"limit":"100"} got a generic parse failure and burned a turn — precisely the
 * failure the issue calls out for Ox/Qwen/DeepSeek-class models.
 *
 * (Distinct from test/llm-repair.test.ts, which covers tool-NAME mangling.)
 *
 * repairToolInput is pure and exported so it is tested directly, and it never
 * throws: an unrepairable call reports what the model should send instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { useTempDir } from "./helpers/tmp.ts";
import { executeTool, repairToolInput } from "../src/agent/tools.ts";

/* ---------- aliases (#17) ---------- */

test("common wrong keys are renamed to the real one (#17)", () => {
  assert.deepEqual(repairToolInput("bash", '{"cmd":"ls"}').args, { command: "ls" });
  assert.deepEqual(repairToolInput("read_file", '{"file_path":"a.ts"}').args, { path: "a.ts" });
  assert.deepEqual(repairToolInput("edit_file", '{"oldValue":"x"}').args, { old_text: "x" });
});

test("an explicit real key is never overwritten by an alias (#17)", () => {
  const r = repairToolInput("bash", '{"cmd":"ls","command":"pwd"}');
  assert.equal(r.args.command, "pwd", "the schema key must win (#17)");
  assert.equal(r.args.cmd, undefined, "the stray alias is dropped, not kept (#17)");
});

test("renaming is recorded as a note (#17)", () => {
  assert.match(repairToolInput("bash", '{"cmd":"ls"}').notes.join(), /renamed "cmd" -> "command"/);
});

/* ---------- type coercion (#17) ---------- */

test("numbers and booleans arriving as strings are coerced (#17)", () => {
  const r = repairToolInput(
    "read_file",
    '{"path":"a.ts","limit":"10","offset":"3","ignore_case":"true"}',
  );
  assert.equal(r.args.limit, 10);
  assert.equal(r.args.offset, 3);
  assert.equal(r.args.ignore_case, true);
});

test("a non-numeric string is NOT coerced to a number (#17)", () => {
  // coercing "all" to NaN would be worse than leaving it for the tool to report
  const r = repairToolInput("read_file", '{"path":"a.ts","limit":"all"}');
  assert.equal(r.args.limit, "all", "only real numerics coerce (#17)");
});

test("coercion is not applied to keys the schema does not declare (#17)", () => {
  const wrong = repairToolInput("bash", '{"command":"ls","not_a_number":"5"}');
  assert.equal(wrong.args.not_a_number, "5", "unknown keys are untouched (#17)");
});

/* ---------- shapes (#17) ---------- */

test("a scalar where a list is expected becomes a list (#17)", () => {
  const r = repairToolInput("read_file", '{"paths":"a.ts"}');
  assert.deepEqual(r.args.paths, ["a.ts"], "paths must be an array (#17)");
});

test("a JSON-stringified object is unwrapped (#17)", () => {
  const whole = repairToolInput("read_file", '"{\\"path\\":\\"a.ts\\"}"');
  assert.equal(whole.args.path, "a.ts", "whole-payload stringification (#17)");
  const nested = repairToolInput("read_file", '{"path":"{\\"path\\":\\"a.ts\\"}"}');
  assert.equal(nested.args.path, "a.ts", "object hidden inside an argument (#17)");
});

test("a genuinely non-JSON argument value is left alone (#17)", () => {
  const r = repairToolInput("write_file", '{"path":"a.ts","content":"{not json}"}');
  assert.equal(r.args.content, "{not json}", "must not mangle real content (#17)");
});

/**
 * REGRESSION (found while building this): an earlier version unwrapped ANY
 * JSON-looking argument value, so writing `{"v":0}` into a .json file silently
 * replaced the content with the inner field's value — data loss, not repair.
 * Repair must never touch data arguments.
 */
test("JSON file CONTENT is never unwrapped (#17)", () => {
  const payload = JSON.stringify({ path: "a.json", content: '{"v":0}', base_content: "x" });
  const r = repairToolInput("write_file", payload);
  assert.equal(r.args.content, '{"v":0}', "file content must survive verbatim (#17)");
  assert.equal(r.args.path, "a.json");

  const edit = repairToolInput(
    "edit_file",
    JSON.stringify({ path: "a.ts", old_text: '{"a":1}', new_text: '{"a":2}' }),
  );
  assert.equal(edit.args.old_text, '{"a":1}', "old_text must survive verbatim (#17)");
  assert.equal(edit.args.new_text, '{"a":2}', "new_text must survive verbatim (#17)");
});

test("markdown framing is stripped from a path (#17)", () => {
  assert.equal(repairToolInput("read_file", '{"path":"**`a.ts`**"}').args.path, "a.ts");
});

/* ---------- unrepairable (#17) ---------- */

test("an unrepairable call says what to send instead (#17)", () => {
  // apply_patch takes an object, so a bare word cannot be salvaged into it
  const r = repairToolInput("apply_patch", "not json at all");
  assert.ok(r.error, "must be reported, not thrown (#17)");
  assert.match(r.error!, /JSON object/, "the error must show the expected shape (#17)");
});

test("a bare word is salvaged only where a single string makes sense (#17)", () => {
  const r = repairToolInput("bash", "ls");
  assert.equal(r.args.command, "ls", "a bare command is recoverable (#17)");
  const obj = repairToolInput("apply_patch", "12");
  assert.ok(obj.error, "a bare scalar is not a patch (#17)");
});

test("repair never throws on hostile input (#17)", () => {
  for (const raw of ["", "   ", "{", "[]", "null", "123", '"str"', "{\"a\":", "��"]) {
    assert.doesNotThrow(
      () => repairToolInput("bash", raw),
      `threw on ${JSON.stringify(raw)} (#17)`,
    );
  }
});

test("well-formed arguments pass through untouched (#17)", () => {
  const r = repairToolInput("read_file", '{"path":"a.ts","limit":10}');
  assert.deepEqual(r.args, { path: "a.ts", limit: 10 });
  assert.deepEqual(r.notes, [], "no change means no notes (#17)");
});

/* ---------- end to end: a repaired call actually does the work (#17) ---------- */

test("a malformed read_file now succeeds instead of erroring (#17)", async () => {
  await useTempDir("rep17-", async (d) => {
    await writeFile(path.join(d, "a.ts"), "AAA\nBBB\nCCC\n");
    const ctx = { cwd: d, defaultTimeoutMs: 5_000, maxOutputBytes: 10_000 };
    for (const raw of [
      '{"file_path":"a.ts"}',
      '{"path":"**`a.ts`**"}',
      '{"path":"a.ts","limit":"2"}',
      '{"paths":"a.ts"}',
    ]) {
      const r = await executeTool("read_file", raw, ctx);
      assert.ok(r.ok, `should succeed for ${raw}: ${r.result} (#17)`);
      assert.ok(r.result.includes("AAA"), `should return content for ${raw} (#17)`);
    }
  });
});

test("a malformed bash now runs instead of erroring (#17)", async () => {
  await useTempDir("rep17b-", async (d) => {
    const ctx = { cwd: d, defaultTimeoutMs: 5_000, maxOutputBytes: 10_000 };
    const r = await executeTool("bash", '{"cmd":"echo hello-from-repair"}', ctx);
    assert.ok(r.ok, r.result);
    assert.match(r.result, /hello-from-repair/, "the aliased command must have run (#17)");
  });
});

test("the single-read format is unchanged by repair (#17)", async () => {
  await useTempDir("rep17c-", async (d) => {
    await writeFile(path.join(d, "a.ts"), "AAA\nBBB\n");
    const ctx = { cwd: d, defaultTimeoutMs: 5_000, maxOutputBytes: 10_000 };
    assert.equal(
      (await executeTool("read_file", '{"path":"a.ts"}', ctx)).result,
      "1| AAA\n2| BBB\n3| ",
      "repair must not alter the output format (#17)",
    );
  });
});