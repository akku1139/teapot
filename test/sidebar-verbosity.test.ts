import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  treeRowsOf,
  sidebarRowsOf,
  wsChatCountsOf,
  type TreeAgent,
} from "../frontend/lib/sidebar-tree.ts";

const _app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

const a = (id: string, workspace: string, parent = ""): TreeAgent => ({ id, workspace, parent });

function render(agents: readonly TreeAgent[], wsCollapsed: Set<string> = new Set(), subs = new Set<string>()) {
  const chats = new Set([...wsCollapsed].filter((k) => k.startsWith("chat:")));
  return sidebarRowsOf(agents, treeRowsOf(agents, subs, false, chats), wsCollapsed);
}
const shape = (rows: ReturnType<typeof render>) =>
  rows.map((r) => (r.headerOnly ? `dir:${r.wsHeader}` : `chat:${r.a.id}${r.depth ? "@sub" : ""}`));
const chats = (rows: ReturnType<typeof render>) => rows.filter((r) => !r.headerOnly).map((r) => r.a.id);

test("six chats in one directory render seven rows, not thirteen (#58)", () => {
  const agents = ["teapot", "teapot-2", "teapot-3", "teapot-4", "teapot-5", "teapot-6"].map((id) =>
    a(id, "/p/teapot"),
  );
  assert.deepEqual(shape(render(agents)), [
    "dir:/p/teapot",
    "chat:teapot",
    "chat:teapot-2",
    "chat:teapot-3",
    "chat:teapot-4",
    "chat:teapot-5",
    "chat:teapot-6",
  ]);
});

test("one chat per project renders two rows, not three (#58)", () => {
  const agents = [a("proj-a", "/p/teapot"), a("proj-b", "/p/router"), a("proj-c", "/p/docs")];
  assert.deepEqual(shape(render(agents)), [
    "dir:/p/teapot",
    "chat:proj-a",
    "dir:/p/router",
    "chat:proj-b",
    "dir:/p/docs",
    "chat:proj-c",
  ]);
});

test("rows are at most one header per directory plus one per chat (#58)", () => {
  const agents = [
    a("a", "/p/one"),
    a("b", "/p/one"),
    a("c", "/p/one"),
    a("d", "/p/two"),
    a("e", "", "a"),
  ];
  const rows = render(agents);
  const headers = rows.filter((r) => r.headerOnly).length;
  const chatRows = rows.filter((r) => !r.headerOnly).length;
  assert.equal(headers, 2, "two directories → two headers (#58)");
  assert.equal(chatRows, 5, "five agents → five rows (#58)");
  assert.equal(rows.length, headers + chatRows);
});

test("per-chat collapse still works, so nothing was traded away (#58)", () => {
  const agents = [a("bugfix", "/p/teapot"), a("review", "/p/teapot"), a("other", "/p/other")];
  const rows = render(agents, new Set(["chat:bugfix"]));
  assert.equal(rows.find((r) => !r.headerOnly && r.a.id === "bugfix")!.chatCollapsedGroup, true);
  assert.deepEqual(chats(rows), ["bugfix", "review", "other"]);
});

test("a chat with no sub-agents is still collapsible (#58)", () => {
  const agents = [a("solo", "/p/teapot"), a("other", "/p/teapot")];
  const rows = render(agents, new Set(["chat:solo"]));
  assert.equal(rows.find((r) => !r.headerOnly && r.a.id === "solo")!.chatCollapsedGroup, true);
});

test("directory collapse still works and keeps its header (#58)", () => {
  const agents = [a("a", "/p/one"), a("b", "/p/one"), a("c", "/p/two")];
  const rows = render(agents, new Set(["ws:/p/one"]));
  assert.deepEqual(shape(rows), ["dir:/p/one", "dir:/p/two", "chat:c"]);
  assert.equal(rows[0]!.wsCollapsedGroup, true, "and reads as collapsed (#58)");
  assert.equal(rows[1]!.wsCollapsedGroup, false, "the sibling directory does not (#58)");
});

test("a sub-agent nests under its chat, and the chat is still one group (#58)", () => {
  const agents = [a("a", "/p/one"), a("a-sub", "", "a"), a("a-sub-2", "", "a-sub")];
  assert.deepEqual(shape(render(agents)), ["dir:/p/one", "chat:a", "chat:a-sub@sub", "chat:a-sub-2@sub"]);
  const collapsed = render(agents, new Set(["chat:a"]));
  assert.deepEqual(chats(collapsed), ["a"]);
  assert.equal(collapsed.find((r) => !r.headerOnly)!.chatCollapsedGroup, true);
});

test("a directory's chat count excludes sub-agents (#58)", () => {
  const agents = [a("solo", "/p/teapot"), a("s1", "", "solo"), a("s2", "", "solo")];
  assert.equal(wsChatCountsOf(agents).get("/p/teapot"), 1, "sub-agents must not inflate the count (#58)");
});

test("a chat collapsed before the header existed stays collapsed (#58)", () => {
  const agents = [a("proj-a", "/p/teapot"), a("proj-b", "/p/router")];
  const rows = render(agents, new Set(["chat:proj-a"]));
  assert.equal(
    rows.find((r) => !r.headerOnly && r.a.id === "proj-a")!.chatCollapsedGroup,
    true,
    "the stored key must still be honoured (#58)",
  );
});

test("a collapsed directory drops EVERY chat under it, not just the first (#58)", () => {
  const agents = ["a", "b", "c", "d"].map((id) => a(id, "/p/one"));
  assert.deepEqual(chats(render(agents, new Set(["ws:/p/one"]))), []);
});

test("a collapsed chat dropped its sub-agents too (#58)", () => {
  const agents = [a("p", "/p/one"), a("s", "", "p"), a("other", "/p/one")];
  assert.deepEqual(chats(render(agents, new Set(["chat:p"]))), ["p", "other"]);
});

test("a chat with no workspace lists with no header (#58)", () => {
  assert.deepEqual(shape(render([a("nowhere", "")])), ["chat:nowhere"]);
});

test("an empty tree renders nothing (#58)", () => {
  assert.deepEqual(render([]), []);
});

test("one directory renders ONE header even when its chats are interleaved (#62)", () => {
  const agents = [
    a("teapot", "/p/teapot"),
    a("teapot-2", "/p/teapot"),
    a("tyb2", "/p/tyb2"),
    a("teapot-7", "/p/teapot"),
    a("teapot-8", "/p/teapot"),
  ];
  const headers = render(agents).filter((r) => r.headerOnly).map((r) => r.wsHeader);
  assert.deepEqual(headers, ["/p/teapot", "/p/tyb2"], `a directory must appear once (#62): ${JSON.stringify(headers)}`);
});

test("a header appears exactly once no matter how the chats are ordered (#62)", () => {
  const ids: Array<[string, string]> = [
    ["a", "/one"], ["b", "/two"], ["c", "/one"], ["d", "/two"], ["e", "/one"],
  ];
  for (const perm of [ids, [...ids].reverse(), [ids[2]!, ids[0]!, ids[4]!, ids[1]!, ids[3]!]]) {
    const headers = render(perm.map(([id, ws]) => a(id, ws)))
      .filter((r) => r.headerOnly)
      .map((r) => r.wsHeader);
    assert.equal(new Set(headers).size, headers.length, `a directory repeated (#62): ${JSON.stringify(headers)}`);
    assert.equal(headers.length, 2, `exactly two directories (#62): ${JSON.stringify(headers)}`);
  }
});

test("grouping by directory keeps each group's chat order (#62)", () => {
  const agents = [a("z", "/one"), a("m", "/one"), a("k", "/two")];
  const rows = render(agents);
  assert.deepEqual(
    rows.map((r) => (r.headerOnly ? `dir:${r.wsHeader}` : r.a.id)),
    ["dir:/one", "z", "m", "dir:/two", "k"],
    `within-directory order and directory order must both be stable (#62): ${JSON.stringify(rows)}`,
  );
});

test("a sub-agent still follows its parent across the regrouping (#62)", () => {
  const agents = [a("p1", "/one"), a("p2", "/two"), a("k1", "", "p1")];
  const rows = render(agents);
  const kid = rows.find((r) => !r.headerOnly && r.a.id === "k1")!;
  assert.equal(kid.depth, 1, "a sub-agent is still indented under its chat (#62)");
  const i = rows.findIndex((r) => !r.headerOnly && r.a.id === "p1");
  assert.equal(rows[i + 1]!.a.id, "k1", "the subtree stays with its parent (#62)");
});
