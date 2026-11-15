/**
 * A usage line that survives a compaction must not contradict the notice (#249).
 *
 * MEASURED in `prismrv-2-9bb8660a`: the harness progress request logged at 09:37:19 carried
 * "context 75% used (787k/1049k tokens) · auto-compacts at 786k · 0 until auto-compaction" — correct at that instant — and the
 * compaction ran 40 seconds later (786,697 -> 24,036 tokens). The kept TAIL still held that message, so the model's next
 * reasoning read "The context is at 75%, near auto-compaction" while the notice at the front of the same conversation said 1%.
 *
 * The notice is the single owner of "how much is used now"; a retained message may not carry a second answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/agent/agent.ts", import.meta.url), "utf8");

function matches(text: string): boolean {
  const m = /const STALE_USAGE_LINE = (\/.*?\/);/.exec(SRC);
  assert.ok(m, "the pattern must exist");
  const re = new RegExp(m[1]!.slice(1, -1));
  return re.test(text);
}

test("the real line from the session is recognised", () => {
  assert.equal(
    matches("[harness] now 18:37 · 10h35m into this session · context 75% used (787k/1049k tokens) · auto-compacts at 786k · 0 until auto-compaction"),
    true,
  );
});

test("the post-compaction form is recognised too", () => {
  assert.equal(matches("context 1% used (15k/1049k tokens) · auto-compacts at 786k · 771k until auto-compaction"), true);
});

test("a message without a usage line is left alone", () => {
  assert.equal(matches("[harness] please give a brief progress report"), false);
});

test("the compaction rewrites retained messages instead of keeping the stale number", () => {
  assert.match(SRC, /m\.content\.replace\(STALE_USAGE_LINE/, "the retained tail must be rewritten");
  assert.match(SRC, /see the compaction notice at the top/, "and point at the one authority");
});
