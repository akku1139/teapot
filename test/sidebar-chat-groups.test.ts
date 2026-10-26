import { test } from "node:test";
import assert from "node:assert/strict";
import {
  treeRowsOf,
  sidebarRowsOf,
  workspaceOf,
  chatGroupKeyOf,
  type TreeAgent,
} from "../frontend/lib/sidebar-tree.ts";

const a = (id: string, workspace: string, parent = ""): TreeAgent => ({ id, workspace, parent });

function render(
  agents: readonly TreeAgent[],
  wsCollapsed: Set<string> = new Set(),
  collapsedSubs: Set<string> = new Set(),
) {
  const chats = new Set([...wsCollapsed].filter((k) => k.startsWith("chat:")));
  return sidebarRowsOf(agents, treeRowsOf(agents, collapsedSubs, false, chats), wsCollapsed);
}
const visible = (rows: ReturnType<typeof render>) =>
  rows.filter((r) => !r.headerOnly).map((r) => r.a.id);

test("a directory of six chats renders six rows, not thirteen (#18)", () => {
  const agents = ["teapot", "teapot-2", "teapot-3", "teapot-4", "teapot-5", "teapot-6"].map((id) =>
    a(id, "/p/teapot"),
  );
  const rows = render(agents);
  assert.equal(
    rows.filter((r) => r.headerOnly).length,
    1,
    `exactly one header — the directory. Got: ${JSON.stringify(rows.map((r) => r.wsHeader ?? r.a.id))}`,
  );
  assert.equal(rows.length, 7, "one header plus six chats (#18)");
  assert.deepEqual(visible(rows), ["teapot", "teapot-2", "teapot-3", "teapot-4", "teapot-5", "teapot-6"]);
});

test("no row is a header repeating the chat's own name (#18)", () => {
  const agents = ["teapot", "teapot-2"].map((id) => a(id, "/p/teapot"));
  const rows = render(agents);
  const headers = rows.filter((r) => r.headerOnly);
  assert.equal(headers.length, 1, `one header only (#18): ${JSON.stringify(rows)}`);
  assert.equal(headers[0]!.wsHeader, "/p/teapot", "and it is the directory (#18)");
  assert.equal(
    rows.filter((r) => r.chatHeader !== undefined).length,
    0,
    "no chat headers may be emitted at all (#18)",
  );
});

test("two chats in one directory stay separately collapsible (#18)", () => {
  const agents = [a("bugfix", "/p/teapot"), a("review", "/p/teapot"), a("elsewhere", "/p/other")];
  const rows = render(agents, new Set(["chat:bugfix"]));
  const vis = visible(rows);
  const bugfix = rows.find((r) => !r.headerOnly && r.a.id === "bugfix");
  assert.ok(bugfix, "a collapsed chat must keep its row (#18)");
  assert.equal(bugfix!.chatCollapsedGroup, true, "and be marked collapsed (#18)");
  assert.ok(vis.includes("review"), "its sibling in the SAME directory must remain (#18)");
  assert.ok(vis.includes("elsewhere"), "another directory is untouched (#18)");
});

test("a chat with NO sub-agents is still collapsible (#18)", () => {
  const agents = [a("solo", "/p/teapot"), a("other", "/p/teapot")];
  const rows = render(agents, new Set(["chat:solo"]));
  assert.deepEqual(visible(rows), ["solo", "other"]);
  assert.equal(
    rows.find((r) => !r.headerOnly && r.a.id === "solo")!.chatCollapsedGroup,
    true,
    "the childless chat is collapsed, not hidden (#18)",
  );
});

test("collapsing a chat hides its sub-agents but keeps its own row (#18)", () => {
  const agents = [a("parent", "/p/teapot"), a("sub-1", "", "parent"), a("sub-2", "", "parent"), a("other", "/p/teapot")];
  const vis = visible(render(agents, new Set(["chat:parent"])));
  assert.ok(vis.includes("parent"), "the chat row stays so it can be reopened (#18)");
  assert.ok(vis.includes("other"), "a sibling chat is untouched (#18)");
  assert.ok(!vis.includes("sub-1") && !vis.includes("sub-2"), "its sub-agents are hidden (#18)");
});

test("collapsing the WORKSPACE still hides every chat under it (#18)", () => {
  const agents = ["a", "b", "c"].map((id) => a(id, "/p/teapot"));
  assert.deepEqual(visible(render(agents, new Set(["ws:/p/teapot"]))), []);
  const rows = render(agents, new Set(["ws:/p/teapot"]));
  assert.equal(rows.length, 1, "a collapsed directory keeps its header (#18)");
  assert.equal(rows[0]!.wsCollapsedGroup, true);
});

test("directory and chat collapse compose independently (#18)", () => {
  const agents = [a("a", "/p/one"), a("b", "/p/one"), a("c", "/p/two")];
  assert.deepEqual(visible(render(agents, new Set(["ws:/p/one", "chat:b"]))), ["c"]);
});

test("a sub-agent with children collapses just that subtree (#18)", () => {
  const agents = [
    a("parent", "/p/teapot"),
    a("sub-1", "", "parent"),
    a("sub-1-kid", "", "sub-1"),
    a("sub-2", "", "parent"),
  ];
  const vis = visible(render(agents, new Set(), new Set(["sub-1"])));
  assert.ok(vis.includes("parent"), "the parent stays (#18)");
  assert.ok(vis.includes("sub-1"), "the collapsed row itself stays visible (#18)");
  assert.ok(!vis.includes("sub-1-kid"), "only its own subtree goes (#18)");
  assert.ok(vis.includes("sub-2"), "its sibling stays (#18)");
});

test("a sub-agent never becomes a group of its own (#18)", () => {
  const agents = [a("p", "/p/teapot"), a("kid", "", "p")];
  assert.equal(chatGroupKeyOf(agents, agents[1]!), "chat:p", "a sub-agent rides its parent (#18)");
});

test("a sub-agent inherits its parent's directory and indent (#18)", () => {
  const agents = [a("parent", "/p/teapot"), a("kid", "", "parent")];
  assert.equal(workspaceOf(agents, "kid"), "/p/teapot");
  const kid = render(agents).find((r) => !r.headerOnly && r.a.id === "kid");
  assert.equal(kid?.depth, 1, "a sub-agent is indented one level (#18)");
});

test("a chat with no workspace still lists, with no header (#18)", () => {
  const rows = render([a("nowhere", "")]);
  assert.equal(rows.length, 1, "the chat must still be listed (#18)");
  assert.equal(rows[0]!.a.id, "nowhere");
  assert.equal(rows[0]!.wsHeader, undefined, "no empty directory header (#18)");
});

test("an empty agent list renders nothing (#18)", () => {
  assert.deepEqual(render([]), []);
});

