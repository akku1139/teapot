/**
 * #81 — "a session that HAS sub-agents shows none of them in the chat tree."
 *
 * Two independent defects, both introduced by #62's directory grouping, and
 * both about the same population: sub-agents that end up without a parent row.
 *
 * 1. A collapsed chat `continue`d past the recursion into its children, so a
 *    collapsed chat emitted no rows for its subtree at all. The 🧩 badge counts
 *    against `agents()` rather than the rendered rows, so the badge said "4" while
 *    the tree showed none.
 *
 * 2. An ORPHANED sub-agent — one whose parent is not in the list — was treated
 *    as a root, and the grouping emitted it BEFORE any header, as a bare row
 *    outside its project. Two real ways to get one: 👻 (hideGhosts) filters the
 *    list before the parent-presence check, and removing a parent deletes it
 *    without reparenting its children.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  treeRowsOf,
  sidebarRowsOf,
  workspaceOf,
  type TreeAgent,
} from "../frontend/sidebar-tree.ts";

const a = (id: string, workspace: string, parent = ""): TreeAgent => ({ id, workspace, parent });

/** ids of the rendered chat rows (headers excluded) */
const chats = (rows: ReturnType<typeof sidebarRowsOf>) =>
  rows.filter((r) => !r.headerOnly).map((r) => r.a.id);

/* ---------- 1: a collapsed chat keeps its subtree in the tree ---------- */

test("a collapsed chat is marked collapsed and its subtree is hidden under it (#81)", () => {
  const agents = [a("main", "/p"), a("kid1", "", "main"), a("kid2", "", "main"), a("other", "/p")];
  const rows = sidebarRowsOf(
    agents,
    treeRowsOf(agents, new Set(), false, new Set(["chat:main"])),
    new Set(["chat:main"]),
  );
  const main = rows.find((r) => !r.headerOnly && r.a.id === "main");
  assert.equal(main?.chatCollapsedGroup, true, "the chat must read as collapsed (#81)");
  // the sub-agents are hidden UNDER it — not dropped from the tree, which is
  // what made the 🧩 count disagree with what was displayed
  assert.deepEqual(chats(rows), ["main", "other"], "only the collapsed chat's subtree is hidden (#81)");
});

test("an EXPANDED chat shows its sub-agents (#81)", () => {
  const agents = [a("main", "/p"), a("kid1", "", "main"), a("kid2", "", "main")];
  const rows = sidebarRowsOf(agents, treeRowsOf(agents, new Set(), false, new Set()), new Set());
  // sub-agents render NEWEST FIRST (deliberate — a fresh spawn is what you want
  // to see), so compare as sets rather than asserting an order that is not the
  // contract under test
  assert.deepEqual(
    [...chats(rows)].sort(),
    ["kid1", "kid2", "main"],
    `sub-agents must render (#81): ${JSON.stringify(chats(rows))}`,
  );
  const kid = rows.find((r) => r.a.id === "kid1");
  assert.equal(kid?.depth, 1, "indented under the chat (#81)");
});

/* ---------- 2: hiding ghosts must not orphan live children ---------- */

test("hiding a ghost parent keeps its live child attached (#81)", () => {
  // THE reported case. 👻 used to drop ghost sessions BEFORE the
  // parent-presence check, so a ghost parent with a live child orphaned it: the
  // child became a root and the grouping gave it its own directory group at the
  // BOTTOM of the list, separated from everything. "A session that has
  // sub-agents shows none of them" — they were there, just somewhere else.
  const ghostParent: TreeAgent = { id: "main", workspace: "/gone", parent: "", workspaceMissing: true };
  const liveKid: TreeAgent = { id: "kid", workspace: "", parent: "main", workspaceMissing: false };
  const other: TreeAgent = { id: "other", workspace: "/p", parent: "" };
  const agents = [ghostParent, liveKid, other];

  const rows = sidebarRowsOf(agents, treeRowsOf(agents, new Set(), true, new Set()), new Set());
  const ids = chats(rows);
  assert.ok(ids.includes("kid"), `the live child must still be listed (#81): ${JSON.stringify(ids)}`);
  // and it must still sit directly under its parent, not in a trailing group
  const kidRow = rows.find((r) => !r.headerOnly && r.a.id === "kid");
  assert.equal(kidRow?.depth, 1, `the child must stay indented under its parent (#81); depth=${kidRow?.depth}`);
  const mainRow = rows.find((r) => !r.headerOnly && r.a.id === "main");
  assert.ok(mainRow, "the ghost parent is kept as the anchor its child needs (#81)");
  // the ordinary live agent is untouched
  assert.ok(ids.includes("other"), `unrelated agents are unaffected (#81): ${JSON.stringify(ids)}`);
});

test("a wholly-ghost subtree is still hidden by 👻 (#81)", () => {
  // the fix must not turn 👻 into a no-op: if nothing visible descends from a
  // ghost, there is nothing to anchor and it goes
  const agents: TreeAgent[] = [
    { id: "g1", workspace: "/x", parent: "", workspaceMissing: true },
    { id: "g2", workspace: "", parent: "g1", workspaceMissing: true },
    { id: "ok", workspace: "/p", parent: "" },
  ];
  const rows = sidebarRowsOf(agents, treeRowsOf(agents, new Set(), true, new Set()), new Set());
  assert.deepEqual(chats(rows), ["ok"], `a ghost subtree with nothing live in it is hidden (#81): ${JSON.stringify(chats(rows))}`);
});

test("👻 off shows ghost parents and their children together (#81)", () => {
  const agents: TreeAgent[] = [
    { id: "main", workspace: "/gone", parent: "", workspaceMissing: true },
    { id: "kid", workspace: "", parent: "main", workspaceMissing: false },
  ];
  const rows = sidebarRowsOf(agents, treeRowsOf(agents, new Set(), false, new Set()), new Set());
  assert.deepEqual([...chats(rows)].sort(), ["kid", "main"], "nothing changes with 👻 off (#81)");
});

test("workspaceOf falls back to the agent's own workspace for an orphan (#81)", () => {
  assert.equal(
    workspaceOf([a("orphan", "/p", "gone")], "orphan"),
    "/p",
    "an unresolvable parent must not erase the directory (#81)",
  );
  assert.equal(workspaceOf([a("p", "/p"), a("k", "", "p")], "k"), "/p");
  assert.doesNotThrow(() => workspaceOf([a("x", "", "y"), a("y", "", "x")], "x"));
});

/* ---------- the ordinary shapes still work ---------- */

test("a normal tree is unchanged (#81)", () => {
  const agents = [
    a("alpha", "/one"),
    a("alpha-kid", "", "alpha"),
    a("beta", "/two"),
    a("beta-kid", "", "beta"),
  ];
  const rows = sidebarRowsOf(agents, treeRowsOf(agents, new Set(), false, new Set()), new Set());
  assert.deepEqual(chats(rows), ["alpha", "alpha-kid", "beta", "beta-kid"]);
  assert.deepEqual(rows.filter((r) => r.headerOnly).map((r) => r.wsHeader), ["/one", "/two"]);
});
