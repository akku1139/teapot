import { test } from "node:test";
import assert from "node:assert/strict";
import { treeRowsOf, sidebarRowsOf, chatGroupKeyOf } from "../frontend/lib/sidebar-tree.ts";

interface A {
  id: string;
  parent?: string;
  workspace: string;
  workspaceMissing?: boolean;
}
const agent = (id: string, parent = ""): A => ({ id, parent, workspace: "/w", workspaceMissing: false });

function badgeShown(rowId: string, collapsedSubs: Set<string>, chatCollapsed: Set<string>, collapsedChat?: boolean): boolean {
  return collapsedSubs.has(rowId) || (collapsedChat === true && chatCollapsed.has(`chat:${rowId}`));
}

test("a COLLAPSED CHAT renders the sub-count badge (#81)", () => {
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

