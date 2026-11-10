/**
 * The goal pane resizes like the tasks pane, and its save button keeps its own colour.
 *
 * Two reports on the same card, both about it NOT matching what the operator already had:
 *  - "goalの表示欄がリサイズできない (tasksがうまく出来てるのに)" — `.todopane` carries `resize: vertical` plus a
 *    ResizeObserver that remembers the height; the goal box had neither;
 *  - "save goalのボタンの色が変わった" — the goal save was reassigned to the tasks' green `okbtn`; the goal has always
 *    been the accent `primarybtn`, and matching the tasks SHAPE was not a request to recolour the action.
 *
 * happy-dom performs no layout, so this pins the pieces that make resizing work: the shared class (which carries
 * `resize: vertical`) and the storage key that remembers a dragged height.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cssRuleBodies } from "./helpers/css.ts";

const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");
const goal = readFileSync(new URL("../frontend/components/goal-pane.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

test("the goal box is resizable through the same class the tasks pane uses", () => {
  const bodies = cssRuleBodies(css, ".goalbox");
  const shared = bodies.find((b) => /resize:/.test(b)) ?? "";
  assert.match(shared, /resize:\s*vertical/, "a dragged edge is what the operator expects from the tasks pane");
  assert.match(shared, /overflow-y:\s*auto/);
  assert.match(goal, /class="content mdpreview goalbox"/, "the rendered goal uses it");
  assert.match(goal, /class="mono todopane-edit goalbox"/, "and so does the editor");
});

test("the dragged height is remembered under the goal's own key", () => {
  assert.match(goal, /teapot\.goalH/, "the goal must not overwrite the tasks height (teapot.todoH)");
  assert.match(goal, /new ResizeObserver/, "the height is written back as it is dragged");
});

test("save goal keeps its accent colour", () => {
  const row = app.slice(app.indexOf("✓ save goal") - 400, app.indexOf("✓ save goal") + 40);
  assert.match(row, /class="primarybtn"/, "matching the tasks SHAPE must not recolour the goal action");
  assert.doesNotMatch(row, /class="okbtn"/);
});
