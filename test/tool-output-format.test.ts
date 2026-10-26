import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToolOutput } from "../frontend/lib/tool-output-lang.ts";

test("a compact JSON result is laid out one field per line (#tool)", () => {
  const out = formatToolOutput('{"instances":[{"pid":271633,"project":"kernel"}],"connected":true}');
  assert.equal(
    out.split("\n").length > 4,
    true,
    `a nested object must span lines, matching argsBlock: ${out}`,
  );
  assert.match(out, /^\{\n/, "and start on its own line — indent 1, like the arguments (#tool)");
  assert.deepEqual(JSON.parse(out), JSON.parse('{"instances":[{"pid":271633,"project":"kernel"}],"connected":true}'));
});

test("already pretty JSON is left byte-identical (#tool)", () => {
  const pretty = '{\n "a": 1\n}';
  assert.equal(formatToolOutput(pretty), pretty, "no pointless rewrite of something already laid out");
});

test("non-JSON output is never touched (#tool)", () => {
  for (const s of ["total 60\ndrwxr-xr-x 2 root root 4096", "Error: boom", "{not json", "[1,2", ""]) {
    assert.equal(formatToolOutput(s), s, `must pass through unchanged: ${JSON.stringify(s)}`);
  }
});

test("a bare JSON scalar is not reformatted (#tool)", () => {
  for (const s of ['"hello"', "42", "true", "null"]) {
    assert.equal(formatToolOutput(s), s, `no structure to lay out: ${s}`);
  }
});

test("indent matches argsBlock so a call and its result line up (#tool)", () => {
  const out = formatToolOutput('{"a":{"b":1}}');
  assert.match(out, /\n "a"/, "a top-level key is indented by one space (#tool)");
  assert.match(out, /\n {2}"b"/, "and the next level by two (#tool)");
});
