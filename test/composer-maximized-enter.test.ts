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
import path from "node:path";
import { fileURLToPath } from "node:url";

const _here = path.dirname(fileURLToPath(import.meta.url));

