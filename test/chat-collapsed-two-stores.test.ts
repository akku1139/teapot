import { test } from "node:test";
import assert from "node:assert/strict";
import { treeRowsOf, sidebarRowsOf, descendantsOf } from "../frontend/lib/sidebar-tree.ts";

interface A {
  id: string;
  parent?: string;
  workspace: string;
  workspaceMissing?: boolean;
}
const agent = (id: string, parent = ""): A => ({ id, parent, workspace: "/w", workspaceMissing: false });

test("a stale collapsedSubs entry for a CHAT hides its subtree (#81)", () => {
  const agents = [agent("teapot"), ...["s1", "s2", "s3", "s4"].map((n) => agent(`teapot-sub-${n}`, "teapot"))];
  const rows = sidebarRowsOf(
    agents,
    treeRowsOf(agents, new Set(["teapot"]), false, new Set()), 
    new Set(),
  );
  const visible = rows.filter((r) => !r.headerOnly);
  assert.equal(
    visible.filter((r) => r.depth > 0).length,
    0,
    "precondition: a collapsedSubs entry for the chat hides every child (#81)",
  );
});

test("the badge still counts them, which is why it read 🧩8 with no rows (#81)", () => {
  const agents = [agent("teapot"), ...["s1", "s2", "s3", "s4"].map((n) => agent(`teapot-sub-${n}`, "teapot"))];
  assert.equal(
    descendantsOf(agents, "teapot").length,
    4,
    "descendantsOf consults neither collapse set, so it counts hidden children (#81)",
  );
});

