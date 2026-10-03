/**
 * #38 — the branch filter's remaining half: should a fork's view include the
 *        history it inherited?
 *
 * The earlier fixes (c215ca9, ff80e32) settled the real bugs — old-branch work
 * surviving an edit, the fork event severing the parent chain, and a filter
 * that merged rows instead of removing them. What was left was a design
 * question left explicitly to the maintainer, so this records the decision as
 * well as the behaviour.
 *
 * The decision: **include the inherited history.** A fork is a new timeline,
 * but the agent's context on it is not empty of the past —
 * `rebuildMessagesFrom` walks the parent chain ACROSS branch boundaries
 * precisely so a restarted fork keeps its history. A filter that showed only
 * the fork's own rows therefore displayed less than the model actually reasons
 * over, which is why it looked like data loss even though the log was intact.
 *
 * Matching the view to the model's context is the whole point of the filter: it
 * exists to answer "what is this branch made of", and the answer includes what
 * it was forked from.
 *
 * Strict filtering stays available (it is the default in `filterByBranch`) so a
 * caller that genuinely wants only a branch's own rows — counting, auditing —
 * is not handed inherited history silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { filterByBranch, type TeapotEvent } from "../src/log/events.ts";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/server/api.ts", import.meta.url), "utf8");

let seq = 0;
function ev(branch: string, parent: string | null, data: unknown = {}): TeapotEvent {
  seq++;
  return {
    v: 1,
    id: `e${seq}`,
    seq,
    ts: "2026-01-01T00:00:00Z",
    agent: "a",
    session: "s",
    branch,
    parent,
    type: "message",
    data,
  };
}

/**
 * A realistic post-fork log:
 *   br0:  1  user
 *         2  assistant
 *         3  fork → creates br1   (recorded on the SOURCE branch, per c215ca9)
 *   br1:  4  user
 *         5  assistant
 */
function forkedLog(): TeapotEvent[] {
  seq = 0;
  const e1 = ev("br0", null, { content: "first" });
  const e2 = ev("br0", "e1", { content: "second" });
  const e3 = ev("br0", "e2", { event: "fork", newBranch: "br1" });
  const e4 = ev("br1", "e3", { content: "after fork" });
  const e5 = ev("br1", "e4", { content: "more after fork" });
  return [e1, e2, e3, e4, e5];
}

const ids = (rows: readonly TeapotEvent[]) => rows.map((e) => e.id);

/* ---------- the decision: a fork shows what it inherited ---------- */

test("lineage filtering includes the history a fork inherited (#38)", () => {
  const rows = filterByBranch(forkedLog(), "br1", true);
  assert.deepEqual(
    ids(rows),
    ["e1", "e2", "e3", "e4", "e5"],
    "a fork's view must include everything before the fork point (#38)",
  );
});

test("the inherited rows really are from the SOURCE branch (#38)", () => {
  // the point of the whole change: rows the strict filter dropped
  const strict = filterByBranch(forkedLog(), "br1", false);
  const lineage = filterByBranch(forkedLog(), "br1", true);
  assert.deepEqual(ids(strict), ["e4", "e5"], "strict shows only the fork's own rows");
  assert.ok(
    lineage.length > strict.length,
    `lineage must be a superset — this is what the strict filter was hiding (#38)`,
  );
  // and the extra rows are the pre-fork ones the model also sees. Compared by
  // ID, not by object identity: the two calls build separate objects for the
  // same events, so `includes()` would report every row as "extra".
  const strictIds = new Set(ids(strict));
  const extra = lineage.filter((e) => !strictIds.has(e.id));
  assert.ok(extra.length > 0, "lineage must add the inherited rows (#38)");
  assert.ok(
    extra.every((e) => e.branch === "br0"),
    "the added rows are the inherited source-branch history (#38)",
  );
});

test("log order is preserved, not regrouped by branch (#38)", () => {
  const rows = filterByBranch(forkedLog(), "br1", true);
  const s = rows.map((e) => e.seq);
  assert.deepEqual(s, [...s].sort((a, b) => a - b), "seq order must survive filtering (#38)");
});

/* ---------- strict stays available and unchanged ---------- */

test("strict filtering is still the default and still exact (#38)", () => {
  assert.deepEqual(
    ids(filterByBranch(forkedLog(), "br1")),
    ["e4", "e5"],
    "an explicit strict filter must not gain inherited rows (#38)",
  );
});

test("strict filtering of the source branch is unaffected (#38)", () => {
  assert.deepEqual(ids(filterByBranch(forkedLog(), "br0", false)), ["e1", "e2", "e3"]);
});

/* ---------- hostile / degenerate input ---------- */

test("an unknown branch yields nothing in either mode (#38)", () => {
  assert.deepEqual(filterByBranch(forkedLog(), "nope", true), []);
  assert.deepEqual(filterByBranch(forkedLog(), "nope", false), []);
});

test("a parent cycle cannot hang or over-collect (#38)", () => {
  seq = 0;
  const a = ev("br1", "e2");
  const b = ev("br1", "e1");
  const rows = filterByBranch([a, b], "br1", true);
  assert.deepEqual(ids(rows), ["e1", "e2"], "a cycle terminates and keeps both rows (#38)");
});

test("a dangling parent id is simply not collected (#38)", () => {
  // a truncated log: the parent points at an event that is not in the file
  seq = 0;
  const rows = filterByBranch([ev("br1", "e-missing")], "br1", true);
  assert.deepEqual(ids(rows), ["e1"], "the missing parent is skipped, not invented (#38)");
});

test("an empty log is empty in both modes (#38)", () => {
  assert.deepEqual(filterByBranch([], "br1", true), []);
  assert.deepEqual(filterByBranch([], "br1", false), []);
});

/* ---------- wiring ---------- */

test("the API exposes the lineage mode and defaults to strict (#38)", () => {
  assert.match(
    api,
    /filterByBranch\(events, branch, c\.req\.query\("lineage"\) === "true"\)/,
    "the endpoint must pass the lineage opt-in through (#38)",
  );
});

test("the web UI asks for the inherited view (#38)", () => {
  assert.match(
    app,
    /&branch=\$\{encodeURIComponent\(bf\)\}&lineage=true/,
    "the timeline must request lineage filtering (#38)",
  );
});

test("the note describes the new behaviour, not the old one (#38)", () => {
  // A stale note is worse than none: it would tell the operator the view hides
  // inherited history, which is now the opposite of what happens.
  assert.doesNotMatch(
    app,
    /reasoning over the history\s*\n?\s*inherited before this branch forked/,
    "the old 'only — the agent also reasons over' note must be gone (#38)",
  );
  assert.match(
    app,
    /and the history it inherited before forking/,
    "the note must say the inherited history IS shown (#38)",
  );
});

/* ---------- #77: BOTH fetch paths must agree about what a filter means ---------- */

test("both the tail and the older-pages fetch request the inherited view (#77)", () => {
  // The tail fetch asked for `lineage=true`; `loadOlder` did not. So a filtered
  // fork's first page showed the inherited history and scrolling up silently
  // switched to strict filtering — the parent's pre-fork rows disappeared from
  // the top, which reads as data loss (#38 all over again).
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  // Match to end of LINE, not to the next backtick: the template contains a
  // nested one (`&branch=${...}`), so a [^`]* class stops short.
  const fetches = app
    .split("\n")
    .filter((l) => l.includes("/events?limit="))
    .map((l) => l.trim());
  assert.ok(fetches.length >= 2, `expected both event fetches (#77); found ${fetches.length}`);
  for (const url of fetches) {
    assert.match(
      url,
      /branch=\$\{encodeURIComponent\(bf\)\}&lineage=true/,
      `every branch-filtered fetch must ask for lineage, or pagination changes what the filter means (#77): ${url}`,
    );
  }
});

test("the server honours lineage only when asked (#77)", () => {
  // Guard the other half: if the flag stopped mattering, the frontend fix would
  // be correct but pointless.
  const log = readFileSync(new URL("../src/log/events.ts", import.meta.url), "utf8");
  assert.match(log, /if \(!includeInherited\)/, "strict must remain the default (#77)");
  assert.match(
    log,
    /export function filterByBranch\([\s\S]*?includeInherited = false/,
    "the flag must be an explicit opt-in (#77)",
  );
});
