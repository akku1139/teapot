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
