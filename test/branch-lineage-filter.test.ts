import { test } from "node:test";
import assert from "node:assert/strict";
import { filterByBranch, type TeapotEvent } from "../src/log/events.ts";

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

test("lineage filtering includes the history a fork inherited (#38)", () => {
  const rows = filterByBranch(forkedLog(), "br1", true);
  assert.deepEqual(
    ids(rows),
    ["e1", "e2", "e3", "e4", "e5"],
    "a fork's view must include everything before the fork point (#38)",
  );
});

test("the inherited rows really are from the SOURCE branch (#38)", () => {
  const strict = filterByBranch(forkedLog(), "br1", false);
  const lineage = filterByBranch(forkedLog(), "br1", true);
  assert.deepEqual(ids(strict), ["e4", "e5"], "strict shows only the fork's own rows");
  assert.ok(
    lineage.length > strict.length,
    `lineage must be a superset — this is what the strict filter was hiding (#38)`,
  );
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
  seq = 0;
  const rows = filterByBranch([ev("br1", "e-missing")], "br1", true);
  assert.deepEqual(ids(rows), ["e1"], "the missing parent is skipped, not invented (#38)");
});

test("an empty log is empty in both modes (#38)", () => {
  assert.deepEqual(filterByBranch([], "br1", true), []);
  assert.deepEqual(filterByBranch([], "br1", false), []);
});
