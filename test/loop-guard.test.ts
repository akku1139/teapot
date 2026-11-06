import assert from "node:assert/strict";
import test from "node:test";
import { isDegenerateRepeat } from "../src/agent/loop-guard.ts";

test("a runaway repetition is recognised (#209)", () => {
  /**
   * "DeepSeekが `  ********` を一生吐いたりするので無駄にトークン食って困る".
   */
  assert.equal(isDegenerateRepeat("thinking" + "  ********".repeat(60)), true, "the reported shape");
  assert.equal(isDegenerateRepeat("*".repeat(200)), true, "one character forever");
  assert.equal(isDegenerateRepeat("abc".repeat(80)), true, "a short phrase on a loop");
  assert.equal(isDegenerateRepeat("x".repeat(39) + "y"), false, "under the threshold");
});

test("ordinary formatting is not a loop (#209)", () => {
  // these must never abort a stream: they are how documents look
  assert.equal(isDegenerateRepeat("---"), false);
  assert.equal(isDegenerateRepeat("```ts\nconst a = 1;\n```"), false);
  assert.equal(isDegenerateRepeat("| a | b |\n|---|---|\n| 1 | 2 |"), false);
  assert.equal(isDegenerateRepeat("a".repeat(30)), false, "a short run is still fine");
  assert.equal(isDegenerateRepeat(""), false);
  assert.equal(isDegenerateRepeat(null), false);
});

test("only the tail is judged (a long answer that ends with prose is fine)", () => {
  const body = "x".repeat(500) + " and then the actual conclusion follows here.";
  assert.equal(isDegenerateRepeat(body), false);
});
