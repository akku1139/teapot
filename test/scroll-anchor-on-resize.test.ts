import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";

/**
 * Resizing the window must not move the reader's place in the timeline.
 *
 * MEASURED before the fix: narrowing the window left `scrollTop` at 2701 while `scrollHeight` shrank
 * 6753 → 5941, so the same pixel offset landed two rows further down — the top visible row went from
 * `message 15` to `message 18`. The pixel offset was preserved; the reader's PLACE was not.
 *
 * The cause was a comparison against itself:
 *
 *     const anchorRow = firstVisibleRow(f);              // measures the row AND its top NOW
 *     const delta = el.getBoundingClientRect().top - anchorRow.top;   // always 0
 *
 * `firstVisibleRow` returns `{sel, top}` from ONE frame, so the subtraction is always zero and the
 * "keep the reader's place" branch could never run. An anchor is only meaningful if it was captured
 * BEFORE the layout changed, which is why the scroll path maintains it and this path reads it.
 *
 * MEASURED after: `message 15` → `message 15` → `message 15` across narrow-then-wide.
 */
test("the box-change restore uses an anchor captured BEFORE the layout changed (#scroll)", () => {
  const app = readSource("frontend/App.tsx");
  const at = app.indexOf("const restoreAfterBoxChange");
  assert.ok(at > 0, "restoreAfterBoxChange must exist");
  const body = app.slice(at, app.indexOf("const scheduleRestore", at));
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    code,
    /const anchorRow = firstVisibleRow\(f\)/,
    "measuring the anchor HERE compares a row against itself — the delta is always 0, so the " +
      "branch is dead and the reader's place moves on every resize (#scroll)",
  );
  assert.match(
    code,
    /const anchorRow = unskipAnchor/,
    "the anchor must be the one the SCROLL path recorded (#scroll)",
  );
});

test("the scroll path keeps that anchor current (#scroll)", () => {
  const app = readSource("frontend/App.tsx");
  assert.match(
    app,
    /unskipAnchor = firstVisibleRow\(el\)/,
    "something must actually record the anchor, or the restore has nothing to aim at (#scroll)",
  );
});
