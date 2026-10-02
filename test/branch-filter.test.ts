/**
 * #38 — "the branch filter on the timeline doesn't work well?"
 *
 * The half of #38 that is a genuine BUG (the other half is the design
 * question of whether a fork view should include inherited history, which is
 * left to the operator).
 *
 * Two defects in the filter itself:
 *
 *  1. loadEvents() union-merges the fetched page with the events already in
 *     state, and that merge NEVER filters by branch. So clicking a branch
 *     re-fetched that branch's rows and then merged them with — and kept — every
 *     row from the previously-shown branch. The old rows stayed on screen
 *     forever, which is precisely "the filter doesn't work".
 *  2. A filter change did not bump `feedGeneration`, so an in-flight fetch for
 *     the previous filter could land afterwards and repopulate the view with
 *     the very rows the operator just filtered out. A filter change is a new
 *     VIEW, exactly like a session switch, and needs the same treatment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/** the branch-click handler body */
function branchClickBody(): string {
  const i = app.indexOf("const next = branchFilter() === b.branch ? null : b.branch;");
  assert.ok(i > 0, "branch click handler not found");
  return app.slice(i, i + 1400);
}

/* ---------- 1: stale rows must be dropped on a filter change ---------- */

test("changing the branch filter clears the previous rows (#38)", () => {
  const body = branchClickBody();
  assert.match(
    body,
    /setEvents\(\[\]\)/,
    "loadEvents union-merges with prev, so the old branch's rows must be dropped (#38)",
  );
});

test("a filter change resets the pagination state (#38)", () => {
  const body = branchClickBody();
  assert.match(body, /setEventsTotal\(0\)/, "the stale total must be cleared (#38)");
  assert.match(
    body,
    /setOlderDone\(false\)/,
    "olderDone must reset or 'load older' stays disabled for the new filter (#38)",
  );
});

/* ---------- 2: in-flight results must be discarded ---------- */

test("a filter change bumps feedGeneration (#38)", () => {
  const body = branchClickBody();
  assert.match(
    body,
    /feedGeneration\+\+/,
    "a filter change is a new view; in-flight results from the old one must be dropped (#38)",
  );
});

test("the generation bump is guarded so re-clicking is harmless (#38)", () => {
  // clicking the already-selected branch CLEARS the filter (shows all again) —
  // that is still a view change, so the guard must be on "did the filter
  // actually change", not on "is a branch selected"
  const body = branchClickBody();
  assert.match(body, /const changing = next !== branchFilter\(\)/, "guard on the real transition (#38)");
  assert.match(body, /if \(changing\)/, "the reset must only run on a real change (#38)");
});

test("a no-op click still reloads rather than doing nothing (#38)", () => {
  // clearing the filter (clicking the active branch) must still re-fetch, or
  // the rows dropped by the previous filter never come back
  const body = branchClickBody();
  const ifIdx = body.indexOf("if (changing)");
  const loadIdx = body.lastIndexOf("loadEvents(selected()!)");
  assert.ok(ifIdx > 0 && loadIdx > ifIdx, "loadEvents must run outside the guard (#38)");
});

/* ---------- the semantics are now stated in the UI ---------- */

test("the filter explains that it now SHOWS the inherited history (#38)", () => {
  // The behaviour changed: the filter used to hide inherited history and the
  // note admitted it, which read as data loss. It now includes that history, so
  // the note must describe the new behaviour — a note left describing the old
  // one would actively mislead.
  assert.match(
    app,
    /showing <b>\{branchFilter\(\)\}<\/b> and the history it inherited before forking/,
    "the note must say the inherited history IS shown (#38)",
  );
  assert.doesNotMatch(
    app,
    /showing <b>\{branchFilter\(\)\}<\/b> only/,
    "the old 'only — hides inherited history' wording must be gone (#38)",
  );
});

/* ---------- session switching keeps its own behaviour ---------- */


/* ---------- session switching keeps its own behaviour ---------- */

test("session switching still bumps the generation and clears rows (#38)", () => {
  // the fix must not have disturbed the session-switch path, which already
  // did all of this for its own reasons
  const start = app.indexOf("feedGeneration++;");
  assert.ok(start > 0, "select() must still bump the generation");
  const after = app.slice(start, start + 1200);
  assert.match(after, /setEvents\(\[\]\)/, "select() clears rows (unchanged)");
  assert.match(after, /evCache\.clear\(\)/, "select() clears the event cache (unchanged)");
});
