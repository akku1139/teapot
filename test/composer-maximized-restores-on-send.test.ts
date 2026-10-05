/**
 * #138 — with the composer maximized, pressing the SEND BUTTON does not restore
 * the normal size.
 *
 * ## This is a regression I introduced
 *
 * #134 made Enter not send from a maximized composer, and in the same change
 * removed the collapse-on-send, reasoning:
 *
 *     // #134: this USED to restore the normal view. The rationale was that
 *     // "staying maximized hid the timeline for no reason" …
 *
 * That rationale was **factually wrong**. Maximizing is:
 *
 *     .composer.maximized { position: absolute; inset: 0; z-index: 5; }
 *
 * — it covers the entire main column and hides the timeline ENTIRELY. That is the
 * point of the mode, not an accident. So removing the restore left the timeline
 * permanently covered with no explanation, and with Enter no longer sending, the
 * send button was the only way out of a mode the user could not otherwise leave
 * after sending.
 *
 * The fix restores it on every send path. A test asserts the CSS fact the whole
 * argument rests on, so the rationale cannot be repeated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readSource(path.join(here, "..", "frontend", "App.tsx"));
const css = readSource(path.join(here, "..", "frontend", "app.css"));

/* ---------- the premise ---------- */

test("maximize really does hide the timeline (#138)", () => {
  // #134's justification was "staying maximized hid the timeline for no reason".
  // Pin the fact that makes that FALSE, so nobody re-derives the same bad reason.
  const i = css.indexOf(".composer.maximized {");
  assert.notEqual(i, -1, "the maximized rule must exist (#138)");
  const rule = css.slice(i, css.indexOf("}", i));
  assert.match(rule, /position:\s*absolute/, "it overlays the column (#138)");
  assert.match(rule, /inset:\s*0/, "covering all of it (#138)");
  assert.match(rule, /background:\s*var\(--bg-dark\)/, "and paints over it opaquely (#138)");
});

/* ---------- the behaviour ---------- */

test("sending restores the normal composer (#138)", () => {
  const at = app.indexOf("const sendText = async (text: string, targetId?: string) => {");
  assert.notEqual(at, -1, "sendText must exist (#138)");
  const body = app.slice(at, app.indexOf("\n  };\n", at));
  assert.match(
    body,
    /if \(composerMaximized\(\)\) \{\s*setComposerMaximized\(false\);/,
    "a send from a maximized composer must restore it (#138)",
  );
});

test("the restore re-runs autosize, or the textarea keeps the tall height (#138)", () => {
  // the expanded height comes from CSS keyed on `.maximized`, so dropping the
  // class without re-measuring leaves the box at its maximized size
  const at = app.indexOf("setComposerMaximized(false);");
  assert.notEqual(at, -1, "the restore must exist (#138)");
  const block = app.slice(at, at + 300);
  assert.match(
    block,
    /autosizeComposer\(\)/,
    "re-measure under the new layout (#138)",
  );
  assert.match(
    block,
    /requestAnimationFrame/,
    "after the class change has been laid out (#138)",
  );
});

test("the restore is CONDITIONAL — a normal send must not touch it (#138)", () => {
  const at = app.indexOf("const sendText = async (text: string, targetId?: string) => {");
  const body = app.slice(at, app.indexOf("\n  };\n", at));
  assert.match(
    body,
    /if \(composerMaximized\(\)\)/,
    "only a maximized composer is restored (#138)",
  );
});

test("the toggle still restores it, for the send-less case (#138)", () => {
  // maximizing and then changing your mind is not a send
  assert.match(
    app,
    /const next = !composerMaximized\(\);/,
    "the maximize button must remain the other way out (#138)",
  );
});

/* ---------- #134 must not have been undone ---------- */

test("Enter still does not send from a maximized composer (#134, #138)", () => {
  // #138 restores the collapse; it must NOT bring back the Enter shortcut the
  // user asked to remove
  const at = app.indexOf('if (e.key === "Enter" && !e.shiftKey && !imeInProgress');
  assert.notEqual(at, -1, "the Enter branch must exist (#134)");
  const line = app.slice(app.lastIndexOf("\n", at) + 1, app.indexOf("\n", at));
  assert.match(line, /!composerMaximized\(\)/, "Enter still yields when maximized (#134/#138)");
});
