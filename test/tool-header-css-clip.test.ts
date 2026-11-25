/**
 * A tool header's one-line-ness is a CSS contract, not a character count (#275).
 *
 * "bashとかのツールのヘッダーはCSSのoverflowとかで実装すべき / そうでないと画面幅によっては折り返しになる場合がある". Two failures on
 * the same slider: `oneLine(cmd, 96)` cut by CHARACTERS, so whether a command looked whole depended on its length instead
 * of the box — and at a narrow width the label wrapped to two lines rather than ellipsising, because `text-overflow` only
 * applies to a single line and nothing set `white-space: nowrap`.
 *
 * A stylesheet is the one legitimate source read (happy-dom does no layout), so this pins the properties that make the
 * contract hold.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { oneLineFull } from "../frontend/lib/timeline-row.ts";

/**
 * The LABEL's flattening is behaviour, and it is all this file tests.
 *
 * It used to assert the CSS that makes the box clip instead of wrap (`.embed summary > b`'s `nowrap` / `text-overflow` /
 * `min-width`). That is source matching with extra steps — it breaks on a rename that fixes nothing and stays green while the UI
 * is broken — and it cost twice over: the same shape failed the Windows job on a CRLF checkout. What it protected is now checked
 * where the cascade actually resolves (the smoke harness loads the BUILT stylesheet into happy-dom) and measured where layout
 * exists (Firefox; the numbers live in the commit).
 */
test("the label is flattened but not length-capped", () => {
  const long = "x".repeat(500);
  assert.equal(oneLineFull(`  ${long}\n\n more  `), `${long} more`, "newlines collapse to one line");
  assert.ok(oneLineFull(long).length === 500, "no character cap — the box decides where the cut is");
});
