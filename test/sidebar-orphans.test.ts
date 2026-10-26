import { test } from "node:test";
import assert from "node:assert/strict";
import {
  treeRowsOf,
  sidebarRowsOf,
  workspaceOf,
  type TreeAgent,
} from "../frontend/lib/sidebar-tree.ts";

const a = (id: string, workspace: string, parent = ""): TreeAgent => ({ id, workspace, parent });

const chats = (rows: ReturnType<typeof sidebarRowsOf>) =>
  rows.filter((r) => !r.headerOnly).map((r) => r.a.id);

test("a collapsed chat is marked collapsed and its subtree is hidden under it (#81)", () => {
  const agents = [a("main", "/p"), a("kid1", "", "main"), a("kid2", "", "main"), a("other", "/p")];
  const rows = sidebarRowsOf(
    agents,
    treeRowsOf(agents, new Set(), false, new Set(["chat:main"])),
    new Set(["chat:main"]),
  );
  const main = rows.find((r) => !r.headerOnly && r.a.id === "main");
  assert.equal(main?.chatCollapsedGroup, true, "the chat must read as collapsed (#81)");
  assert.deepEqual(chats(rows), ["main", "other"], "only the collapsed chat's subtree is hidden (#81)");
});

test("an EXPANDED chat shows its sub-agents (#81)", () => {
  const agents = [a("main", "/p"), a("kid1", "", "main"), a("kid2", "", "main")];
  const rows = sidebarRowsOf(agents, treeRowsOf(agents, new Set(), false, new Set()), new Set());
  assert.deepEqual(
    [...chats(rows)].sort(),
    ["kid1", "kid2", "main"],
    `sub-agents must render (#81): ${JSON.stringify(chats(rows))}`,
  );
  const kid = rows.find((r) => r.a.id === "kid1");
  assert.equal(kid?.depth, 1, "indented under the chat (#81)");
});

test("hiding a ghost parent keeps its live child attached (#81)", () => {
  const ghostParent: TreeAgent = { id: "main", workspace: "/gone", parent: "", workspaceMissing: true };
  const liveKid: TreeAgent = { id: "kid", workspace: "", parent: "main", workspaceMissing: false };
  const other: TreeAgent = { id: "other", workspace: "/p", parent: "" };
  const agents = [ghostParent, liveKid, other];

  const rows = sidebarRowsOf(agents, treeRowsOf(agents, new Set(), true, new Set()), new Set());
  const ids = chats(rows);
  assert.ok(ids.includes("kid"), `the live child must still be listed (#81): ${JSON.stringify(ids)}`);
  const kidRow = rows.find((r) => !r.headerOnly && r.a.id === "kid");
  assert.equal(kidRow?.depth, 1, `the child must stay indented under its parent (#81); depth=${kidRow?.depth}`);
  const mainRow = rows.find((r) => !r.headerOnly && r.a.id === "main");
  assert.ok(mainRow, "the ghost parent is kept as the anchor its child needs (#81)");
  assert.ok(ids.includes("other"), `unrelated agents are unaffected (#81): ${JSON.stringify(ids)}`);
});

test("a wholly-ghost subtree is still hidden by 👻 (#81)", () => {
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
