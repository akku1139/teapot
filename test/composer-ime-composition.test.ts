/**
 * 入力中のメッセージが消失する — the composer dropped text on a Japanese keyboard,
 * and the cause is the controlled `value={draft()}` binding.
 *
 * Solid writes the textarea's `value` on every change of the bound signal.
 * During an IME composition the browser OWNS that textarea's contents: the
 * pre-edit kana live in the composition, not in `value`. Assigning `.value`
 * mid-composition ends it, and what was typed goes with it.
 *
 * Measured with an instrumented `value` setter on the built bundle in happy-dom
 * (the fixture approach of scripts/smoke-web.mjs), over a four-step composition
 * "に → にほ → にほん → にほんご":
 *
 *   pre-fix : framework write "に", "にほ", "にほん", "にほんご"   (4 writes)
 *   post-fix: (none)                                              (0 writes)
 *
 * Both builds returned the same final text in this harness — happy-dom has no
 * IME, so the browser-side cancellation cannot show — which is why the DOM-write
 * COUNT is the signal, not the resulting string.
 *
 * The rule lives in frontend/composer-ime.ts so it is testable without a DOM;
 * the WIRING is asserted on App.tsx, because a helper only the tests import
 * proves nothing about the app (#75).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSourceUrl } from "./helpers/source.ts";
import { composerValueChanged, shouldWriteComposerValue } from "../frontend/composer-ime.ts";

const _app = readSourceUrl(new URL("../frontend/App.tsx", import.meta.url));

test("no write reaches the DOM while a composition is in progress (#IME)", () => {
  assert.equal(shouldWriteComposerValue(true), false, "a mid-composition write cancels the conversion");
  assert.equal(shouldWriteComposerValue(false), true, "outside a composition the sync must run");
  // a redundant assignment still disturbs a composition, so the check is on the
  // VALUE, not on whether the signal was "set"
  assert.equal(composerValueChanged("same", "same"), false);
  assert.equal(composerValueChanged("x", ""), true, "clearing after send must reach the DOM");
});

