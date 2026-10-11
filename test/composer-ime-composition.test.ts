/**
 * 入力中のメッセージが消失する — the composer dropped text on a Japanese
 * keyboard, and the cause is the controlled `value={draft()}` binding.
 *
 * Solid writes the textarea's `value` every time the bound signal changes.
 * During an IME composition the browser OWNS that textarea's contents: the
 * pre-edit kana live in the composition, not in `value`. Assigning `.value`
 * mid-composition ends it, and what was typed so far goes with it.
 *
 * Measured, not reasoned: an instrumented bundle driven in happy-dom (same
 * fixture as scripts/smoke-web.mjs) counted FOUR `.value` writes across a
 * simulated four-step composition, and ZERO after the fix:
 *
 *   pre-fix : framework write "に" / "にほ" / "にほん" / "にほんご"
 *   post-fix: (none)
 *
 * The DOM count is what matters — a "did the text change?" check inside the
 * component cannot see it, because the browser cannot tell a redundant
 * assignment from a real one, and both disturb the composition.
 *
 * The rule lives in frontend/composer-ime.ts so it is testable without a DOM;
 * the WIRING is asserted on App.tsx, because a helper only the tests import
 * proves nothing about the app (#75).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import { composerValueChanged, shouldWriteComposerValue } from "../frontend/composer-ime.ts";

const app = readSource(new URL("../frontend/App.tsx", import.meta.url).pathname);

/** the composer textarea's opening tag */
function composerTag(): string {
  const at = app.indexOf("ref={(el) => {\n                  composerEl = el;");
  assert.notEqual(at, -1, "the composer textarea must seed its own value (#IME)");
  return app.slice(at, app.indexOf("onpaste=", at));
}

test("no write reaches the DOM while a composition is in progress", () => {
  assert.equal(shouldWriteComposerValue(true), false, "a mid-composition write cancels the conversion");
  assert.equal(shouldWriteComposerValue(false), true, "outside a composition the sync must run");
});

test("an unchanged value is not rewritten", () => {
  // a redundant assignment still ends a composition, so the check is on the
  // VALUE, not on whether the signal was "set"
  assert.equal(composerValueChanged("same", "same"), false);
  assert.equal(composerValueChanged("", "x"), true);
  assert.equal(composerValueChanged("x", ""), true, "clearing after send must reach the DOM");
});

test("the composer is a controlled input, but the write is gated (#IME)", () => {
  const tag = composerTag();
  assert.doesNotMatch(
    tag,
    /^\s*value=\{draft\(\)\}/m,
    "`value={draft()}` writes the DOM on every keystroke — the disappearing-text bug",
  );
  assert.match(tag, /el\.value = draft\(\)/, "the initial value must still be seeded from the draft");
  assert.match(tag, /oncompositionstart/, "the composition must be tracked");
  assert.match(tag, /oncompositionend/, "and its end handled");
  // the RESULT must be committed to the signal, or the next sync overwrites it.
  // Order within the handler is not the point (the deferred flag reset and the
  // commit are independent), so this looks at the handler as a whole.
  const end = app.slice(app.indexOf("oncompositionend"), app.indexOf("onpaste=", app.indexOf("oncompositionend")));
  assert.match(end, /saveDraft\(composerEl\?\.value/, "the composition's result must be committed (#IME)");
});

test("the sync effect that replaced the binding stands down while composing (#IME)", () => {
  const at = app.indexOf("shouldWriteComposerValue(imeInProgress)");
  assert.notEqual(at, -1, "the sync effect must consult the gate (#IME)");
  const eff = app.slice(app.lastIndexOf("createEffect", at), at + 400);
  assert.match(eff, /composerValueChanged\(composerEl\.value, v\)/, "and skip a no-op write (#IME)");
  // the draft must be a DEPENDENCY, or the effect would never re-run on typing
  assert.match(eff, /const v = draft\(\)/, "reading the draft is what subscribes the effect (#IME)");
});

test("Enter during a composition still confirms instead of sending (#12)", () => {
  // the sibling rule this must not break: the send path consults the SAME flag
  assert.match(app, /!imeInProgress/, "the send guard must still check the flag (#12)");
});
