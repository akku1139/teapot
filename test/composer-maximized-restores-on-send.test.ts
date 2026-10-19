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
import { blockFrom, readSource, stripSourceComments } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const _app = readSource(path.join(here, "..", "frontend", "App.tsx"));

/* ---------- the premise ---------- */

