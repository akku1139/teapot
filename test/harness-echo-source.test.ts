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
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readSource(path.join(here, "..", "frontend", "App.tsx"));
const echoMod = readSource(path.join(here, "..", "frontend", "pending-echo.ts"));

test("the queue -> echo mapping keeps source (#122)", () => {
  // the snapshot already sends it; the mapping was the thing that dropped it
  const at = app.indexOf("const missing = queue.filter");
  assert.notEqual(at, -1, "the queue effect must exist (#122)");
  const block = app.slice(at, at + 800);
  assert.match(block, /q\.source/, "source must survive the mapping (#122)");
  assert.match(block, /source: q\.source/, "and land on the echo (#122)");
});

test("echoEv uses the real source instead of hardcoding user (#122)", () => {
  const at = app.indexOf("function echoEv");
  assert.notEqual(at, -1, "echoEv must exist (#122)");
  const block = app.slice(at, at + 1100);
  assert.doesNotMatch(
    block,
    /source: "user"/,
    "the hardcoded value is the bug — a harness prompt rendered as the operator's (#122)",
  );
  assert.match(block, /source: p\.source \?\? "user"/, "default to user for an older echo (#122)");
});

test("PendingEcho carries source (#122)", () => {
  assert.match(echoMod, /source\?: string/, "the type must carry it (#122)");
});

test("cancel is offered ONLY for an operator prompt (#122)", () => {
  // the serious half: a ✕ on a harness prompt would discard a system message
  const at = app.indexOf("onCancel={");
  assert.notEqual(at, -1, "the cancel affordance must exist (#122)");
  const block = app.slice(at, at + 400);
  assert.match(
    block,
    /e\.data\?\.source === "user"/,
    "only the operator's own prompt can be withdrawn (#122)",
  );
});

test("edit is offered ONLY for an operator prompt (#122)", () => {
  const at = app.indexOf("onEdit={");
  assert.notEqual(at, -1, "the edit affordance must exist (#122)");
  const block = app.slice(at, at + 600);
  assert.match(
    block,
    /e\.data\?\.source === "user"/,
    "a harness prompt has no user text to fork from (#122)",
  );
});

test("the pending marker itself still keys off `pending` (#122)", () => {
  // the visible half of the report: the row must still say "queued…"
  assert.match(app, /e\.data\?\.pending \? "queued…"/, "the queued label must remain (#122)");
  assert.match(app, /e\.data\?\.pending \? " pending"/, "and the pending class (#122)");
});

test("a harness prompt is still not counted as a logged user prompt (#122)", () => {
  // line 1129 builds `loggedUserPrompts`, which decides whether an echo is
  // superseded by its log row — harness rows must not join that set
  const at = app.indexOf("loggedUserPrompts.add(");
  assert.notEqual(at, -1, "the set must be built (#122)");
  const block = app.slice(Math.max(0, at - 260), at + 80);
  assert.match(block, /source === "user"/, "only user prompts enter it (#122)");
});
