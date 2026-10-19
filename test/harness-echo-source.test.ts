/**
 * #122 — "a message from the harness is pending, yet no pending indicator is
 * shown on it. It isn't something that can be cancelled, but as a UI it is hard
 * to tell."
 *
 * ## Cause
 *
 * The agent snapshot DOES carry `pendingPromptQueue[].source`, and the effect that
 * materialises echoes read the queue — but dropped `source` on the floor, and
 * `echoEv` then hardcoded it:
 *
 *     data: { source: "user", … }
 *
 * So every queued prompt rendered as an operator one. Three consequences, and the
 * report only names the first:
 *
 *   1. a harness prompt looked like an ordinary user message, so "is it queued?"
 *      was unanswerable from the row;
 *   2. it grew a ✕ **cancel** — which cannot work, since there is no composer
 *      draft to return the text to;
 *   3. it could grow an ✎ **edit** affordance, which would fork from text the
 *      operator never typed.
 *
 * (2) and (3) are the more serious half: the UI was offering actions that either
 * fail or do the wrong thing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _here = path.dirname(fileURLToPath(import.meta.url));

