import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampPaneIndex,
  indexAfterAppend,
  paneIndexAfterClose,
  rightPaneSeed,
} from "../frontend/lib/term-tabs.ts";

test("the index of a newly appended tab is the OLD length (#172)", () => {
  assert.equal(indexAfterAppend([]), 0);
  assert.equal(indexAfterAppend(["a"]), 1);
  assert.equal(indexAfterAppend(["a", "b"]), 2);
  const list = ["a", "b"];
  const at = indexAfterAppend(list);
  const after = [...list, "c"];
  assert.ok(at < after.length, `index ${at} must be inside a list of ${after.length}`);
  assert.equal(after[at], "c", "and it must address the tab that was just added");
});

test("a pane index past the end is clamped, an empty list has none (#172)", () => {
  assert.equal(clampPaneIndex(2, 2), 1, "one past the end lands on the last tab");
  assert.equal(clampPaneIndex(9, 3), 2);
  assert.equal(clampPaneIndex(0, 0), -1);
  assert.equal(clampPaneIndex(-1, 3), -1, "an empty pane stays empty");
  assert.equal(clampPaneIndex(1, 5), 1);
  assert.equal(clampPaneIndex(0, 5), 0);
});

test("closing the tab a pane SHOWS lands on a real neighbour (#172)", () => {
  assert.equal(paneIndexAfterClose(1, 1, 2), 1);
  assert.equal(paneIndexAfterClose(2, 2, 2), 1);
  assert.equal(paneIndexAfterClose(0, 0, 0), -1);
  assert.equal(paneIndexAfterClose(0, 2, 2), 0);
  assert.equal(paneIndexAfterClose(2, 0, 2), 1);
  assert.notEqual(paneIndexAfterClose(1, 1, 2), -1);
});

test("the right pane seeds on a DIFFERENT tab than the left (#172)", () => {
  assert.equal(rightPaneSeed(0, 2), 1);
  assert.equal(rightPaneSeed(1, 2), 0);
  assert.equal(rightPaneSeed(0, 3), 1);
  assert.equal(rightPaneSeed(0, 1), -1);
  assert.equal(rightPaneSeed(-1, 0), -1);
});

test("an out-of-range pane index is repaired to a real tab (#172)", async () => {
  const { clampPaneIndex } = await import("../frontend/lib/term-tabs.ts");
  assert.equal(clampPaneIndex(3, 2), 1, "past the end clamps to the last tab");
  assert.equal(clampPaneIndex(1, 1), 0, "one past a single tab clamps to it");
  assert.equal(clampPaneIndex(0, 0), -1, "an empty list has no tab to show");
  assert.equal(clampPaneIndex(1, 3), 1, "a valid index is left alone");
  assert.equal(clampPaneIndex(-1, 3), -1, "-1 means no pane chosen, not the first tab");
});

