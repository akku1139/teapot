/**
 * #134 — "while the input is expanded, Enter should NOT send."
 *
 * ## What was wrong
 *
 * Two things, and the second was the more surprising.
 *
 * **Enter sent regardless.** The composer's keydown sent on `Enter && !shiftKey`
 * with no reference to the expanded state, so a maximized composer — which exists
 * to write long text — could not be typed into: every newline was a send.
 *
 * **Sending collapsed it.** `sendText` did:
 *
 *     if (composerMaximized()) setComposerMaximized(false);
 *
 * with the rationale that "staying maximized hid the timeline for no reason".
 * That reason only holds if you cannot see the reply — but with Enter no longer
 * sending, a maximized composer is a deliberate writing mode held for a whole
 * message, and collapsing it mid-message threw away the mode that was asked for.
 *
 * So the two behaviours together made the expanded composer unusable in both
 * directions: Enter sent when you wanted a newline, and the send that happened
 * instead destroyed the expansion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readSource(path.join(here, "..", "frontend", "App.tsx"));

test("Enter does NOT send from a maximized composer (#134)", () => {
  const at = app.indexOf('if (e.key === "Enter" && !e.shiftKey && !imeInProgress');
  assert.notEqual(at, -1, "the composer's Enter branch must exist (#134)");
  // #126: bound by the handler, not a fixed width — this send branch is short
  const line = app.slice(app.lastIndexOf("\n", at) + 1, app.indexOf("\n", at));
  assert.match(line, /!composerMaximized\(\)/, "Enter must yield to the expanded state (#134)");
});

test("the IME guard and shift-Enter still behave (#134)", () => {
  const at = app.indexOf('if (e.key === "Enter" && !e.shiftKey && !imeInProgress');
  const line = app.slice(app.lastIndexOf("\n", at) + 1, app.indexOf("\n", at));
  assert.match(line, /!e\.shiftKey/, "shift-Enter still means a newline (#134)");
  assert.match(line, /!imeInProgress/, "and IME composition must still win (#134)");
});

test("sending no longer collapses a maximized composer (#134)", () => {
  // the other half: with Enter no longer sending, the expanded composer is a mode
  // the operator holds for a whole message, so a send must not destroy it
  const at = app.indexOf("await sendText(text);");
  assert.notEqual(at, -1, "sendText must exist (#134)");
  const after = app.slice(at, app.indexOf("const executeSlash", at));
  assert.doesNotMatch(
    after,
    /setComposerMaximized\(false\)/,
    "sending must not restore the normal view (#134)",
  );
});

test("the toggle can still restore it (#134)", () => {
  // nothing becomes unreachable: maximizing stays reversible
  assert.match(
    app,
    /const next = !composerMaximized\(\);/,
    "the maximize button must still toggle (#134)",
  );
  assert.match(
    app,
    /class=\{"composer" \+ \(composerMaximized\(\) \? " maximized" : ""\)\}/,
    "and the class must still reflect the state (#134)",
  );
});
