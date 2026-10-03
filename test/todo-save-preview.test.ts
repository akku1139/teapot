/**
 * #88 — "after 'save tasks' I want it to go to preview mode, not carry on
 * editing."
 *
 * `saveTodo` POSTed the list, cleared the dirty flag and flashed a hint — but
 * left the markdown editor open. So the button gave no visible confirmation that
 * anything had happened, and the natural next action was to keep typing.
 *
 * Saving now flips to the rendered checklist, which shows what was actually
 * stored and is the only way to see the agent's formatting of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

test("saving the task list switches to the rendered preview (#88)", () => {
  const i = app.indexOf("const saveTodo = async () => {");
  assert.notEqual(i, -1, "saveTodo must exist (#88)");
  const body = app.slice(i, app.indexOf("  };", i));
  assert.match(
    body,
    /setTodoViewMode\(true\)/,
    "saving must leave edit mode and show the result (#88)",
  );
  // and only on SUCCESS — a failed save leaves the editor open with the text
  assert.match(
    body,
    /catch[\s\S]{0,200}?flashHint\(`save failed/,
    "a failed save must keep the editor so the text is not hidden (#88)",
  );
});

test("the view toggle still exists, so preview is reversible (#88)", () => {
  assert.match(
    app,
    /onClick=\{\(\) => setTodoViewMode\(!todoViewMode\(\)\)\}/,
    "the pencil/eye toggle must remain, so the operator can go back to editing (#88)",
  );
});

test("the dirty flag is still cleared on save (#88)", () => {
  // the preview must not also imply the draft is still unsaved
  const i = app.indexOf("const saveTodo = async () => {");
  const body = app.slice(i, app.indexOf("  };", i));
  assert.match(body, /setTodoDirty\(false\)/, "saving must clear the dirty flag (#88)");
});
