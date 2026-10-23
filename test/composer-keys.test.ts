/**
 * #134 / #138 — the composer's TWO key/send decisions, as behaviour.
 *
 * These replace two files that had become documentation: each read `App.tsx` into an unused const
 * and contained no `test()` at all, so the reported bugs were "covered" by nothing while the suite
 * listed them as suites. The decisions now live in `frontend/composer-keys.ts`, so they can be
 * called directly.
 *
 * #134 — "while the input is expanded, Enter should NOT send."
 *   The composer sent on `Enter && !shiftKey` regardless of the expanded state, so the mode that
 *   exists to write LONG text could not be typed into: every newline sent.
 *
 * #138 — "with the composer maximized, pressing the SEND BUTTON does not restore it."
 *   The expanded composer is `position: absolute; inset: 0` over the column, so a send must exit it
 *   or the reply it just asked for is hidden behind it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldSendOnKey, shouldRestoreAfterSend } from "../frontend/lib/composer-keys.ts";

const key = (over: Partial<Parameters<typeof shouldSendOnKey>[0]> = {}) =>
  shouldSendOnKey({ key: "Enter", shiftKey: false, composing: false, maximized: false, ...over });

test("Enter sends in the normal composer (#134)", () => {
  assert.equal(key(), true, "the plain case must still work, or the fix broke sending");
});

test("Enter does NOT send while the composer is expanded (#134)", () => {
  assert.equal(
    key({ maximized: true }),
    false,
    "an expanded composer is a writing mode — Enter must be a newline there (#134)",
  );
});

test("Shift+Enter never sends, expanded or not (#134)", () => {
  assert.equal(key({ shiftKey: true }), false);
  assert.equal(key({ shiftKey: true, maximized: true }), false);
});

test("Enter during an IME composition commits the candidate, it does not send (#134)", () => {
  /**
   * `isComposing` is already false by the time Enter's keydown arrives in Safari, which is why the
   * caller tracks the composition itself and passes it in here rather than reading the event.
   */
  assert.equal(key({ composing: true }), false, "a conversion must not fire the message");
});

test("only Enter is treated as a send key (#134)", () => {
  for (const k of ["a", "Escape", "Tab", " ", "NumpadEnter"]) {
    assert.equal(key({ key: k }), false, `${JSON.stringify(k)} must not send`);
  }
});

test("a send restores the expanded composer (#138)", () => {
  assert.equal(shouldRestoreAfterSend(true), true, "the reply must not stay hidden behind the composer");
  assert.equal(shouldRestoreAfterSend(false), false, "and a normal composer must not be disturbed");
});
