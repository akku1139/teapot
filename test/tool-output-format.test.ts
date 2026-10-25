import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToolOutput } from "../frontend/lib/tool-output-lang.ts";

/**
 * A JSON tool RESULT is laid out like the ARGUMENTS beside it.
 *
 * `argsBlock` renders `JSON.stringify(args, null, 1)` — one field per line — while the output was
 * shown as whatever the server sent. Most MCP tools return JSON, so a single-line blob sat next to a
 * pretty-printed argument block for the same call: same data, two shapes, and the output side was
 * the unreadable one.
 *
 * The rule that matters: only a WHOLE JSON value is rewritten. Anything else must come through
 * byte-identical — reformatting shell output or a truncated result would be a confident lie about
 * the content.
 */
test("a compact JSON result is laid out one field per line (#tool)", () => {
  const out = formatToolOutput('{"instances":[{"pid":271633,"project":"kernel"}],"connected":true}');
  assert.equal(
    out.split("\n").length > 4,
    true,
    `a nested object must span lines, matching argsBlock: ${out}`,
  );
  assert.match(out, /^\{\n/, "and start on its own line — indent 1, like the arguments (#tool)");
  // the DATA must be untouched: same parse, nothing dropped or reordered
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
  // `outputLang` deliberately does not call a bare string/number JSON — there is no structure
  for (const s of ['"hello"', "42", "true", "null"]) {
    assert.equal(formatToolOutput(s), s, `no structure to lay out: ${s}`);
  }
});

test("indent matches argsBlock so a call and its result line up (#tool)", () => {
  // argsBlock uses JSON.stringify(..., null, 1) — one space per level
  const out = formatToolOutput('{"a":{"b":1}}');
  // depth 1 gets one space, depth 2 gets two — the same ladder argsBlock uses
  assert.match(out, /\n "a"/, "a top-level key is indented by one space (#tool)");
  assert.match(out, /\n {2}"b"/, "and the next level by two (#tool)");
});
