import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import { stripSourceComments } from "./helpers/source.ts";

/**
 * Coming back to a session must return the reader to the ROW they were reading.
 *
 * Reported: "セッションを移ってから戻ると数百個前のメッセージまでスクロールが移動することもある".
 * Two mechanisms produced it, and both had to be wrong at once:
 *
 *   - `select()` ended with an unconditional `scrollBottom(true)`, so the position was thrown away
 *     on every switch — including returning to what you were reading;
 *   - a remembered VALUE was a pixel `scrollTop`, which is an offset into content of a different
 *     height. The browser clamps it to the new maximum, so a value captured in a long session
 *     landed hundreds of rows back in a short one.
 *
 * MEASURED on the built bundle (400-row session, scrolled to `top=2000 row=e24`): before, returning
 * gave `top=33504 row=e393` (the tail); after, `top=2000 row=e24`.
 */
test("the switch remembers a ROW, not a pixel offset (#scroll)", () => {
  const app = stripSourceComments(readSource("frontend/App.tsx"));
  const at = app.indexOf("if (prevId !== id || tid !== prevTid) {");
  assert.ok(at > 0, "the switch block must exist");

  /**
   * The capture must be the FIRST thing in the block.
   *
   * MEASURED: with it placed after `setSelected(id)`, every capture logged `anchor: null top: 0`
   * — Solid writes propagate synchronously, so the feed's `<For>` had already re-rendered for the
   * incoming session and there was nothing left to measure. Nothing was ever stored, and the bug
   * looked unfixed.
   */
  const firstSetter = app.indexOf("setSelected(id)", at);
  const capture = app.indexOf("scrollMemory.set", at);
  assert.ok(capture > 0, "the switch must remember where the reader was (#scroll)");
  assert.ok(
    capture < firstSetter,
    "the capture must run BEFORE any signal write — after `setSelected` the feed has already " +
      "re-rendered and there is nothing to measure (#scroll)",
  );

  const block = app.slice(at, firstSetter);
  assert.match(block, /firstVisibleRow/, "the anchor is the first visible row (#scroll)");
  assert.match(block, /data-eid|dataset\.eid/, "and it is identified by its event id, which survives a re-wrap (#scroll)");
  assert.doesNotMatch(
    block,
    /scrollTop\s*[,:}]/,
    "a raw scrollTop must not be the thing remembered — it is an offset into other content (#scroll)",
  );
});

test("returning restores it instead of always scrolling to the tail (#scroll)", () => {
  const app = stripSourceComments(readSource("frontend/App.tsx"));
  const at = app.indexOf("const restore = scrollMemory.get(tid);");
  assert.ok(at > 0, "the switch must consult the remembered position (#scroll)");
  const block = app.slice(at, at + 1400);
  assert.match(block, /querySelector/, "it finds the remembered ROW again (#scroll)");
  assert.match(block, /scrollTop \+=/, "and offsets to it rather than assigning a raw value (#scroll)");
  assert.match(
    block,
    /scrollBottom\(true\)/,
    "the tail is the FALLBACK when the row is gone — a first page may not contain it (#scroll)",
  );
});
