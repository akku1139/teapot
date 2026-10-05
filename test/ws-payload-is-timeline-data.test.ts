/**
 * #54 — the WebSocket payload IS the timeline data.
 *
 * ## The architectural fix
 *
 * The socket already carried the full event: `EventLog.onEvent` fires AFTER the
 * write (#54), so what arrives on the socket is byte-for-byte what is on disk.
 * It was being thrown away in favour of "something changed, re-read /events".
 *
 * That made REST the source of truth and the socket a notification bell — the
 * dual model the issue describes. It is also why a dropped socket could strand a
 * row: nothing the client already held could close the gap, so the only recovery
 * was re-reading a 2,000-event tail.
 *
 * Now `mergeEvents([msg.event])` inserts the event directly. `mergeEvents` dedupes
 * by id and sorts by seq, so a REST page and a socket event may arrive in any
 * order without duplicating or mis-ordering.
 *
 * ## Why this test exists
 *
 * I disabled the `mergeEvents` call and the whole suite stayed green. The smoke
 * test's API-call count is the only thing that noticed — and it is not an
 * assertion. So the property is pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "./helpers/source.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = readSource(path.join(here, "..", "frontend", "App.tsx"));

/** the body of the `kind === "event"` WS branch */
function eventBranch(): string {
  const at = app.indexOf('if (msg.kind === "event") {');
  assert.notEqual(at, -1, "the WS event branch must exist (#54)");
  // bounded by the NEXT top-level branch, not a fixed width
  // Bound by the HIDDEN-TAB check that follows the event branch — the branch has
  // no next `if (msg.kind` sibling, so a search for one found nothing.
  //
  // Two wrong windows first: a fixed 2000 chars (mergeEvents sits at 2431), then a
  // sibling-branch search that does not exist. The fixed-window trap again.
  const rest = app.slice(at + 10);
  const next = rest.indexOf('if (document.visibilityState === "hidden")');
  assert.notEqual(next, -1, "the event branch must be bounded by the hidden-tab check (#54)");
  return rest.slice(0, next);
}

test("the WS event payload is inserted into the timeline (#54)", () => {
  const b = eventBranch();
  assert.match(
    b,
    /mergeEvents\(\[msg\.event as Ev\]\)/,
    "the payload must BE the data, not merely a reason to re-read (#54)",
  );
});

test("inserting the event does not also trigger the old reload (#54)", () => {
  // both would be correct individually and wrong together: the reload would
  // clobber the inserted row and make the socket path pointless
  const b = eventBranch();
  const insert = b.indexOf("mergeEvents([msg.event as Ev])");
  const reload = b.indexOf("runFeedRefresh");
  assert.notEqual(insert, -1, "precondition: the payload is inserted (#54)");
  assert.ok(
    reload === -1 || reload < insert,
    "a socket event must not also schedule a full reload (#54)",
  );
});

test("the reload timer is now only for non-event frames (#54)", () => {
  // the debounce existed solely to collapse a burst of "reload" signals; with the
  // payload carrying the data there is nothing left to collapse
  const timer = app.indexOf("timer = setTimeout(runFeedRefresh, 120)");
  assert.notEqual(timer, -1, "the fallback reload must remain for error paths (#54)");
  const b = eventBranch();
  assert.doesNotMatch(b, /setTimeout\(runFeedRefresh/, "but not on the event path (#54)");
});

test("mergeEvents is idempotent, which is what makes the socket safe (#54)", () => {
  // a socket event and a REST page can carry the SAME event; without dedupe by id
  // the row would appear twice
  const at = app.indexOf("function mergeEvents(");
  assert.notEqual(at, -1, "mergeEvents must exist (#54)");
  const body = app.slice(at, app.indexOf("\n  }\n", at));
  assert.match(body, /new Map<string, Ev>\(\)/, "dedupe by id (#54)");
  // Assert the GUARD, not just the Map: a Map alone does not dedupe, and my first
  // version of this line matched `map.set(e.id, …)` which survives removing the
  // `if (!map.has(…))` entirely — so deleting the dedupe passed.
  assert.match(
    body,
    /if \(!map\.has\(e\.id\)\) map\.set\(e\.id, e\)/,
    "the incoming event must be skipped when its id is already held (#54)",
  );
  assert.match(
    body,
    /for \(const e of prev\) map\.set\(e\.id, e\)/,
    "and the held events must seed the map first (#54)",
  );
  assert.match(body, /sort\(\(a, b\) => a\.seq - b\.seq\)/, "and keep seq order (#54)");
});
