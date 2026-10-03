/**
 * #81 — "there are sessions that have sub-agents but show none of them in the
 * chat tree."
 *
 * Reported still-broken against v0.26.7, after two earlier fixes for this issue
 * (4a330bd, 78f9419) both of which ARE in that release. So this is a third
 * cause, not a missing release.
 *
 * There are TWO ways a subtree gets hidden, and the 🧩 badge only knew about one:
 *
 *   1. collapsing the SUBS      — tracked by `collapsedSubs()`
 *   2. collapsing the CHAT      — tracked by `chatCollapsed()`
 *
 * `treeRowsOf` stops descending in both cases, so in the second the sub-agents
 * disappear — but the badge's gate was `collapsedSubs().has(id)`, which is false
 * for a collapsed chat. Nothing on screen said anything was hidden. That is the
 * reported symptom exactly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { treeRowsOf, sidebarRowsOf, chatGroupKeyOf } from "../frontend/sidebar-tree.ts";

interface A {
  id: string;
  parent?: string;
  workspace: string;
  workspaceMissing?: boolean;
}
const agent = (id: string, parent = ""): A => ({ id, parent, workspace: "/w", workspaceMissing: false });

/** the badge's gate, as App.tsx computes it */
function badgeShown(rowId: string, collapsedSubs: Set<string>, chatCollapsed: Set<string>, collapsedChat?: boolean): boolean {
  return collapsedSubs.has(rowId) || (collapsedChat === true && chatCollapsed.has(`chat:${rowId}`));
}

test("a COLLAPSED CHAT renders the sub-count badge (#81)", () => {
  // the case the badge did not know about
  assert.equal(
    badgeShown("root", new Set(), new Set(["chat:root"]), true),
    true,
    "a collapsed chat hides its subs, so it must show the count (#81)",
  );
});

test("collapsed SUBS still render the badge (#81)", () => {
  assert.equal(badgeShown("root", new Set(["root"]), new Set(), false), true, "unchanged (#81)");
});

test("an expanded chat with nothing collapsed shows no badge (#81)", () => {
  assert.equal(badgeShown("root", new Set(), new Set(), false), false, "nothing hidden, no badge (#81)");
});

test("a collapsed chat really does hide its sub-agents (#81)", () => {
  // the precondition: if the tree did not hide them, the badge would be noise
  const agents = [agent("root"), agent("a", "root"), agent("b", "root")];
  const key = chatGroupKeyOf(agents, agents[0]!);
  const collapsed = new Set([key]);
  const rows = sidebarRowsOf(agents, treeRowsOf(agents, new Set(), false, collapsed), collapsed);
  const subs = rows.filter((r) => !r.headerOnly && r.depth > 0);
  assert.equal(subs.length, 0, "a collapsed chat hides its subs (#81)");
  assert.equal(
    rows.filter((r) => r.chatCollapsedGroup).length,
    1,
    "and marks its own row so the caret can bring it back (#81)",
  );
});

test("the badge gate covers BOTH ways of hiding a subtree (#81)", () => {
  // structural: the old gate named only collapsedSubs
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  const at = app.indexOf("Collapsed tree: surface how many subs");
  assert.notEqual(at, -1, "the badge must exist (#81)");
  // the gate sits just BELOW the comment; 260 chars reached into the comment
  // block and not far enough down, so widen it and anchor on the `<Show`
  const show = app.indexOf("<Show", at);
  assert.notEqual(show, -1, "the badge gate must be a Show (#81)");
  const block = app.slice(at, app.indexOf("</Show>", show));
  assert.match(
    block,
    /collapsedSubs\(\)\.has\(row\.a\.id\)/,
    "collapsing the subs must still count (#81)",
  );
  assert.match(
    block,
    /chatCollapsed\(\)\.has\(`chat:\$\{row\.a\.id\}`\)/,
    "collapsing the CHAT must count too — this is the missing half (#81)",
  );
});

test("the collapsed-chat marker is present, so the gate can fire (#81)", () => {
  // the gate reads `row.chatCollapsedGroup`; if sidebarRowsOf stopped setting it
  // the badge would be dead code again
  const st = readFileSync(new URL("../frontend/sidebar-tree.ts", import.meta.url), "utf8");
  assert.match(st, /chatCollapsedGroup: true/, "a collapsed chat must mark its row (#81)");
});
