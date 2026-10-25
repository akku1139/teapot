/**
 * Terminal drawer tab/pane bookkeeping (#172).
 *
 * The reported symptoms were "勝手に新しいタブを作る" and "タブが生えたのに
 * `no shell here — ＋ opens one, tabs fill the focused pane` のことがある". Both
 * came from one arithmetic mistake: `addTab` read the new tab's index from
 * `termTabs().length` AFTER `setTermTabs`. A Solid setter applies synchronously, so
 * that read is the NEW length — one past the end — and the pane then renders the
 * "no shell here" placeholder while the tab is right there. Pressing ＋ again made
 * another tab, which is why they appeared to spawn on their own.
 *
 * These test the arithmetic directly. Doing it through the DOM would need an xterm
 * instance and a live WebSocket, and the arithmetic is the whole bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampPaneIndex,
  indexAfterAppend,
  paneIndexAfterClose,
  rightPaneSeed,
} from "../frontend/lib/term-tabs.ts";

test("the index of a newly appended tab is the OLD length (#172)", () => {
  // the regression: reading `length` after the append gives one past the end
  assert.equal(indexAfterAppend([]), 0);
  assert.equal(indexAfterAppend(["a"]), 1);
  assert.equal(indexAfterAppend(["a", "b"]), 2);
  // and it really is inside the list once appended — the property that matters,
  // because an index outside the array is what renders "no shell here"
  const list = ["a", "b"];
  const at = indexAfterAppend(list);
  const after = [...list, "c"];
  assert.ok(at < after.length, `index ${at} must be inside a list of ${after.length}`);
  assert.equal(after[at], "c", "and it must address the tab that was just added");
});

test("a pane index past the end is clamped, an empty list has none (#172)", () => {
  // the exact out-of-range value the bug produced (2 for a 2-tab list) must not reach
  // a pane, or it shows the placeholder
  assert.equal(clampPaneIndex(2, 2), 1, "one past the end lands on the last tab");
  assert.equal(clampPaneIndex(9, 3), 2);
  // no tabs at all is genuinely nothing to show
  assert.equal(clampPaneIndex(0, 0), -1);
  assert.equal(clampPaneIndex(-1, 3), -1, "an empty pane stays empty");
  // an untouched valid index must not move — focus is the operator's
  assert.equal(clampPaneIndex(1, 5), 1);
  assert.equal(clampPaneIndex(0, 5), 0);
});

test("closing the tab a pane SHOWS lands on a real neighbour (#172)", () => {
  // three tabs; the pane shows the middle one (1) and it is closed → one tab remains
  // after it (which shifts down to 1) and one before it; index 1 is still valid
  assert.equal(paneIndexAfterClose(1, 1, 2), 1);
  // closing the LAST shown tab must step back, not point past the end
  assert.equal(paneIndexAfterClose(2, 2, 2), 1);
  // closing the only tab leaves nothing to show
  assert.equal(paneIndexAfterClose(0, 0, 0), -1);
  // a pane showing an EARLIER tab is unaffected by a later close
  assert.equal(paneIndexAfterClose(0, 2, 2), 0);
  // a pane showing a LATER tab shifts down with it
  assert.equal(paneIndexAfterClose(2, 0, 2), 1);
  // the old expression produced -1 here (it min'd a -1 against length-1), which is
  // exactly the "tab closed, pane went blank" case
  assert.notEqual(paneIndexAfterClose(1, 1, 2), -1);
});

test("the right pane seeds on a DIFFERENT tab than the left (#172)", () => {
  // split view opening with both panes on one shell is the bug this prevents
  assert.equal(rightPaneSeed(0, 2), 1);
  assert.equal(rightPaneSeed(1, 2), 0);
  assert.equal(rightPaneSeed(0, 3), 1);
  // one tab: there is nothing else to show, so the right pane stays empty rather than
  // duplicating the left one
  assert.equal(rightPaneSeed(0, 1), -1);
  assert.equal(rightPaneSeed(-1, 0), -1);
});

/**
 * #172 — a visible tab must never sit above "no shell here".
 *
 * The panes render "no shell here" when their index is out of range. The list can shrink behind
 * their back in three ways now that terminals are server-owned: another client closes one, the
 * reload restore replaces the whole list, and the server drops a terminal whose shell exited.
 *
 * The repair rule is pure, so it is tested rather than trusted.
 */
test("an out-of-range pane index is repaired to a real tab (#172)", async () => {
  const { clampPaneIndex } = await import("../frontend/lib/term-tabs.ts");
  // the tab that was shown is gone and the list is shorter
  assert.equal(clampPaneIndex(3, 2), 1, "past the end clamps to the last tab");
  assert.equal(clampPaneIndex(1, 1), 0, "one past a single tab clamps to it");
  assert.equal(clampPaneIndex(0, 0), -1, "an empty list has no tab to show");
  assert.equal(clampPaneIndex(1, 3), 1, "a valid index is left alone");
  // `-1` is "deliberately showing nothing" (the right pane in single-pane mode), so it stays:
  // the effect only revives it when the OTHER pane would otherwise be empty
  assert.equal(clampPaneIndex(-1, 3), -1, "-1 means no pane chosen, not the first tab");
});

/**
 * #172 — "nano のリサイズが効かない、閉じて再度開けば効く".
 *
 * `FitAddon.proposeDimensions()` reads `getComputedStyle(this._terminal.element.parentElement)`
 * — the cols/rows come from the PARENT of the element we create. The ResizeObserver used to
 * watch that child (`.termsession`, which is `position: absolute; inset: 0` and tracks its own
 * containing block). While both resize together that is harmless, but a full-screen program
 * repainting through xterm can change the measured box while the child's own box is unchanged.
 * The observer then never fires, no `resize` is sent, and the pty keeps the old geometry until
 * the tab is re-attached — which is exactly "reopening fixes it".
 */
