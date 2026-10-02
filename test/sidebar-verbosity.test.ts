/**
 * #58 — "the chat tree display is far too verbose: too many sections."
 *
 * The report came with a screenshot of a directory holding six chats rendering
 * thirteen rows:
 *
 *     ▾ TEAPOT          <- directory header
 *       ▾ teapot        <- chat header
 *         teapot        <- the chat row
 *       ▾ teapot-2
 *         teapot-2      … thirteen rows for six conversations
 *
 * Two header levels were emitted unconditionally. A later pass suppressed the
 * chat level for SOLO chats, which fixed the one-chat-per-project case and left
 * this one — the level was never the problem, only its unconditional emission
 * and the fact that it needed a row of its own at all.
 *
 * The chat level is now gone. What it bought — per-chat collapse that leaves
 * siblings alone — needs no header, because a top-level chat IS an agent row
 * and its sub-agents already hang beneath it. So the row carries the caret.
 *
 * The POINT of these tests is the row COUNT, because that is what the report
 * measured. Asserting "there is one header" is not enough: a tree can satisfy
 * that and still be verbose. Each case below states the shape it expects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  treeRowsOf,
  sidebarRowsOf,
  wsChatCountsOf,
  type TreeAgent,
} from "../frontend/sidebar-tree.ts";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

const a = (id: string, workspace: string, parent = ""): TreeAgent => ({ id, workspace, parent });

/** the render, using the same two calls App.tsx makes */
function render(agents: readonly TreeAgent[], wsCollapsed: Set<string> = new Set(), subs = new Set<string>()) {
  const chats = new Set([...wsCollapsed].filter((k) => k.startsWith("chat:")));
  return sidebarRowsOf(agents, treeRowsOf(agents, subs, false, chats), wsCollapsed);
}
/** a compact "dir:path" / "chat:id" trace, so a failure prints the shape */
const shape = (rows: ReturnType<typeof render>) =>
  rows.map((r) => (r.headerOnly ? `dir:${r.wsHeader}` : `chat:${r.a.id}${r.depth ? "@sub" : ""}`));
const chats = (rows: ReturnType<typeof render>) => rows.filter((r) => !r.headerOnly).map((r) => r.a.id);

/* ---------- the reported case ---------- */

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
  // the invariant behind both cases: no row exists that is not a directory
  // header or a chat
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

/* ---------- the verbosity is not bought by losing capability ---------- */

test("per-chat collapse still works, so nothing was traded away (#58)", () => {
  const agents = [a("bugfix", "/p/teapot"), a("review", "/p/teapot"), a("other", "/p/other")];
  const rows = render(agents, new Set(["chat:bugfix"]));
  // the collapsed chat keeps a marked row; what must not happen is its SIBLING
  // going with it, which is the #18 bug the second header level existed for
  assert.equal(rows.find((r) => !r.headerOnly && r.a.id === "bugfix")!.chatCollapsedGroup, true);
  assert.deepEqual(chats(rows), ["bugfix", "review", "other"]);
});

test("a chat with no sub-agents is still collapsible (#58)", () => {
  // the capability the removed level existed for, and the one case a "collapse
  // needs children" rule would quietly break
  const agents = [a("solo", "/p/teapot"), a("other", "/p/teapot")];
  const rows = render(agents, new Set(["chat:solo"]));
  assert.equal(rows.find((r) => !r.headerOnly && r.a.id === "solo")!.chatCollapsedGroup, true);
});

test("directory collapse still works and keeps its header (#58)", () => {
  const agents = [a("a", "/p/one"), a("b", "/p/one"), a("c", "/p/two")];
  const rows = render(agents, new Set(["ws:/p/one"]));
  // the collapsed directory keeps its header and loses every chat; the other
  // directory is untouched
  assert.deepEqual(shape(rows), ["dir:/p/one", "dir:/p/two", "chat:c"]);
  assert.equal(rows[0]!.wsCollapsedGroup, true, "and reads as collapsed (#58)");
  assert.equal(rows[1]!.wsCollapsedGroup, false, "the sibling directory does not (#58)");
});

/* ---------- sub-agents still nest, still counted as part of their chat ---------- */

test("a sub-agent nests under its chat, and the chat is still one group (#58)", () => {
  const agents = [a("a", "/p/one"), a("a-sub", "", "a"), a("a-sub-2", "", "a-sub")];
  assert.deepEqual(shape(render(agents)), ["dir:/p/one", "chat:a", "chat:a-sub@sub", "chat:a-sub-2@sub"]);
  // and collapsing the chat takes the whole subtree, keeping only the row
  const collapsed = render(agents, new Set(["chat:a"]));
  assert.deepEqual(chats(collapsed), ["a"]);
  assert.equal(collapsed.find((r) => !r.headerOnly)!.chatCollapsedGroup, true);
});

test("a directory's chat count excludes sub-agents (#58)", () => {
  // the count drives the old "is this a shared directory" decision, so a
  // sub-agent must not make a solo chat look shared
  const agents = [a("solo", "/p/teapot"), a("s1", "", "solo"), a("s2", "", "solo")];
  assert.equal(wsChatCountsOf(agents).get("/p/teapot"), 1, "sub-agents must not inflate the count (#58)");
});

/* ---------- migrated state, and the #18-era bug this file also guarded ---------- */

test("a chat collapsed before the header existed stays collapsed (#58)", () => {
  // `chat:<id>` predates this change and is still in localStorage
  const agents = [a("proj-a", "/p/teapot"), a("proj-b", "/p/router")];
  const rows = render(agents, new Set(["chat:proj-a"]));
  assert.equal(
    rows.find((r) => !r.headerOnly && r.a.id === "proj-a")!.chatCollapsedGroup,
    true,
    "the stored key must still be honoured (#58)",
  );
});

test("a collapsed directory drops EVERY chat under it, not just the first (#58)", () => {
  // regression guard: the check once lived inside the header-emitting branch,
  // so only the row right after a header was dropped
  const agents = ["a", "b", "c", "d"].map((id) => a(id, "/p/one"));
  assert.deepEqual(chats(render(agents, new Set(["ws:/p/one"]))), []);
});

test("a collapsed chat dropped its sub-agents too (#58)", () => {
  // same class of bug: only the chat's own row was skipped
  const agents = [a("p", "/p/one"), a("s", "", "p"), a("other", "/p/one")];
  assert.deepEqual(chats(render(agents, new Set(["chat:p"]))), ["p", "other"]);
});

/* ---------- degenerate input ---------- */

test("a chat with no workspace lists with no header (#58)", () => {
  assert.deepEqual(shape(render([a("nowhere", "")])), ["chat:nowhere"]);
});

test("an empty tree renders nothing (#58)", () => {
  assert.deepEqual(render([]), []);
});

/* ---------- wiring ---------- */

test("App.tsx delegates the tree and grouping to the tested module (#58)", () => {
  assert.match(app, /treeRowsOf\(agents\(\), collapsedSubs\(\), hideGhosts\(\), chatCollapsed\(\)\)/, "the tree must come from the tested module (#58)");
  assert.match(app, /sidebarRowsOf\(agents\(\), treeRows\(\), wsCollapsed\(\)\)/, "the rows must too (#58)");
  assert.match(app, /wsChatCountsOf\(agents\(\)\)/, "the directory count must too (#58)");
});

test("chat collapse reuses the persisted group set rather than new state (#58)", () => {
  // a second signal would mean a second thing to migrate on the next change
  assert.match(app, /const isChat = !row\.a\.parent;/, "the row caret keys off being top-level (#58)");
  assert.match(app, /toggleWsGroup\(`chat:\$\{row\.a\.id\}`/, "and toggles it in the persisted set (#58)");
});
