/**
 * The wire's placeholder is not a message (#279).
 *
 * "thinkingエリアに `(tool call)` が出る" on three different models, all of which reason and then call a tool with no prose.
 * `sanitize()` fills an empty assistant `content` with `"(tool call)"` because the API requires a string; that is a wire
 * value, and rendering it shows a message the model never wrote.
 *
 * The server also stopped persisting it, but older logs still hold such rows, so the check is at the point of display.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isSentinelText } from "../frontend/lib/placeholder-text.ts";

test("the wire's empty-content placeholders are sentinels", () => {
  for (const s of ["(tool call)", "(no content)", "  (tool call)  "]) {
    assert.equal(isSentinelText(s), true, `${JSON.stringify(s)} must not render`);
  }
});

test("real text is not", () => {
  for (const s of ["", "(tool calls)", "I called a tool", "tool call"]) {
    assert.equal(isSentinelText(s), false, `${JSON.stringify(s)} is a message`);
  }
  assert.equal(isSentinelText(undefined), false);
});
