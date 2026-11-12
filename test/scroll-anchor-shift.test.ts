import test from "node:test";
import assert from "node:assert/strict";
import { aboveViewportShift } from "../frontend/lib/scroll-anchor.ts";

test("a row above the viewport shifts the reader by its own height delta", () => {
  // the measured case: a tool card at content y=0 shrinks 412 -> 30 while the reader sits at 1264
  assert.equal(aboveViewportShift([{ top: 0, before: 412, after: 30 }], 1264), -382);
  // and growth pushes the other way
  assert.equal(aboveViewportShift([{ top: 0, before: 30, after: 412 }], 1264), 382);
});

test("a row the reader is looking at does not move the viewport", () => {
  // straddles the viewport top: 1200..1612 with the reader at 1264 — this is the content they came to see
  assert.equal(aboveViewportShift([{ top: 1200, before: 412, after: 30 }], 1264), 0);
});

test("only the rows above are summed, and unchanged rows contribute nothing", () => {
  const rows = [
    { top: 0, before: 100, after: 40 },      // above -> -60
    { top: 100, before: 50, after: 50 },     // unchanged
    { top: 150, before: 60, after: 200 },    // above (ends at 210 <= 500) -> +140
    { top: 400, before: 300, after: 10 },    // straddles 500 -> 0
  ];
  assert.equal(aboveViewportShift(rows, 500), 80);
});
