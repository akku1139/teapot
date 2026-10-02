/**
 * #58 — "the chat tree display is far too verbose: too many sections."
 *
 * #18 introduced a workspace header so unrelated projects stop interleaving,
 * and a follow-up made every TOP-LEVEL chat its own group so two chats sharing
 * a directory stay independently addressable. Both are right in the general
 * case, but together they emitted a header for BOTH levels unconditionally.
 *
 * The common case — one chat per working directory — then rendered three rows
 * saying the same thing:
 *
 *   ▾ teapot                 <- workspace header (directory basename)
 *     ▾ teapot-8f2a1c        <- chat header (the same name, again)
 *       teapot-8f2a1c        <- the chat row
 *
 * The chat header adds nothing: same caret, same name, no sibling to
 * disambiguate it from. With several projects open that redundancy repeats
 * down the sidebar and the tree reads as noise.
 *
 * The fix emits a chat header ONLY when the directory holds more than one
 * top-level chat. When it holds exactly one, the workspace header already IS
 * that chat's group — it carries the caret, the name and the collapse toggle
 * — so the second level is dropped.
 *
 * These tests import the REAL module. The logic was extracted to
 * frontend/sidebar-tree.ts precisely so it could be exercised without a DOM
 * (happy-dom does no layout); an earlier version of this file re-implemented
 * the logic in the test, which made the behavioural assertions pass by
 * construction and catch nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  treeRowsOf,
  sidebarRowsOf,
  wsChatCountsOf,
  workspaceOf,
  chatGroupKeyOf,
  type TreeAgent,
} from "../frontend/sidebar-tree.ts";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

function srcHas(label: string, re: RegExp): void {
  if (!re.test(app)) assert.fail(`${label}\n  expected source to match: ${re}`);
}

const a = (id: string, workspace: string, parent = ""): TreeAgent => ({ id, workspace, parent });

/** a compact "kind:key" trace of a rendered sidebar, for readable diffs */
function trace(
  agents: readonly TreeAgent[],
  collapsed: ReadonlySet<string> = new Set(),
): string[] {
  return sidebarRowsOf(agents, treeRowsOf(agents), collapsed).map((r) =>
    r.headerOnly
      ? r.wsHeader !== undefined
        ? `ws:${r.wsHeader}`
        : `chat:${r.chatHeader!.replace(/^chat:/, "")}`
      : r.a.id,
  );
}

/* ---------- the report: one chat per project produced three rows ---------- */

const soloProjects = [a("proj-a", "/p/teapot"), a("proj-b", "/p/router"), a("proj-c", "/p/docs")];

test("a directory holding ONE chat gets no redundant chat header (#58)", () => {
  const rows = sidebarRowsOf(soloProjects, treeRowsOf(soloProjects));
  const chatHeaders = rows.filter((r) => r.headerOnly && r.chatHeader !== undefined);
  assert.deepEqual(
    chatHeaders,
    [],
    "a solo chat must not get a second header — the workspace header already is its group (#58)",
  );
});

test("one chat per project means exactly two rows each, not three (#58)", () => {
  assert.deepEqual(
    trace(soloProjects),
    ["ws:/p/teapot", "proj-a", "ws:/p/router", "proj-b", "ws:/p/docs", "proj-c"],
    "the sidebar must not stack group/group/chat for a single chat (#58)",
  );
});

test("the chat is still identifiable after its header is dropped (#58)", () => {
  // dropping the header must not cost the operator the chat's identity: the
  // row itself still names the chat, and the directory header still collapses
  // the group.
  const rows = sidebarRowsOf(soloProjects, treeRowsOf(soloProjects));
  const chatRow = rows.find((r) => !r.headerOnly && r.a.id === "proj-a")!;
  assert.ok(chatRow, "the chat row must still be rendered (#58)");
  assert.equal(chatRow.wsHeader, undefined, "a chat row carries no header fields (#58)");
  // and the header above it is what the operator clicks
  const idx = rows.indexOf(chatRow);
  assert.equal(rows[idx - 1]!.wsHeader, "/p/teapot", "the directory header heads the chat (#58)");
});

/* ---------- the #18 behaviour that must NOT regress ---------- */

const shared = [a("bugfix", "/p/teapot"), a("review", "/p/teapot"), a("elsewhere", "/p/other")];

test("a directory holding SEVERAL chats still gets chat headers (#18)", () => {
  const rows = sidebarRowsOf(shared, treeRowsOf(shared));
  const chatHeaders = rows.filter((r) => r.chatHeader !== undefined).map((r) => r.chatHeader);
  assert.deepEqual(
    chatHeaders,
    ["chat:bugfix", "chat:review"],
    "two chats sharing a directory must stay separate, addressable groups (#18)",
  );
});

test("the shared directory still has exactly ONE workspace header (#18)", () => {
  const rows = sidebarRowsOf(shared, treeRowsOf(shared));
  assert.deepEqual(
    rows.filter((r) => r.wsHeader !== undefined).map((r) => r.wsHeader),
    ["/p/teapot", "/p/other"],
    "one header per directory (#18)",
  );
});

test("header levels are chosen per directory, not globally (#58)", () => {
  // the mixed case: /p/teapot holds two chats, /p/other holds one. Suppressing
  // chat headers globally would collapse the two shared chats back into one
  // anonymous bucket — the exact regression #18's follow-up fixed.
  assert.deepEqual(
    trace(shared),
    [
      "ws:/p/teapot",
      "chat:bugfix",
      "bugfix",
      "chat:review",
      "review",
      "ws:/p/other",
      "elsewhere",
    ],
    "the shared directory keeps chat headers; the solo one does not (#58)",
  );
});

test("collapsing one shared chat leaves its sibling alone (#18)", () => {
  const rows = sidebarRowsOf(shared, treeRowsOf(shared), new Set(["chat:bugfix"]));
  const visible = rows.filter((r) => !r.headerOnly).map((r) => r.a.id);
  assert.ok(!visible.includes("bugfix"), "the collapsed chat must be hidden (#18)");
  assert.ok(visible.includes("review"), "its sibling in the SAME directory must remain (#18)");
});

test("collapsing a shared chat keeps its header so it can be reopened (#18)", () => {
  const rows = sidebarRowsOf(shared, treeRowsOf(shared), new Set(["chat:bugfix"]));
  assert.ok(
    rows.some((r) => r.chatHeader === "chat:bugfix"),
    "the collapsed chat's header must survive (#18)",
  );
});

test("collapsing the WORKSPACE hides every chat under it (#18)", () => {
  const rows = sidebarRowsOf(shared, treeRowsOf(shared), new Set(["ws:/p/teapot"]));
  const visible = rows.filter((r) => !r.headerOnly).map((r) => r.a.id);
  assert.deepEqual(visible, ["elsewhere"], "the whole directory's chats go (#18)");
});

/* ---------- migrated collapse state must not strand a chat ---------- */

test("a solo chat collapsed under the OLD scheme stays hidden (#58)", () => {
  // Before #58 a solo chat had its own `chat:<id>` header and collapsing it
  // persisted that key to localStorage. That header is gone now, so if the
  // stale key were ignored the chat would sit on screen with nothing left to
  // click to reopen it — a chat the operator had deliberately hidden.
  const rows = sidebarRowsOf(soloProjects, treeRowsOf(soloProjects), new Set(["chat:proj-a"]));
  const visible = rows.filter((r) => !r.headerOnly).map((r) => r.a.id);
  assert.deepEqual(visible, ["proj-b", "proj-c"], "a solo chat collapsed before #58 must stay hidden (#58)");
  // and the header that now represents it must read as collapsed
  const header = rows.find((r) => r.wsHeader === "/p/teapot")!;
  assert.equal(header.wsCollapsedGroup, true, "its directory header must show it collapsed (#58)");
});

/* ---------- sub-agents ---------- */

test("a sub-agent never gets a chat header of its own (#18)", () => {
  const agents = [...shared, a("bugfix-sub", "", "bugfix")];
  const chatHeaders = sidebarRowsOf(agents, treeRowsOf(agents))
    .filter((r) => r.chatHeader !== undefined)
    .map((r) => r.chatHeader);
  assert.ok(!chatHeaders.includes("chat:bugfix-sub"), "a sub-agent belongs to its parent's group (#18)");
});

test("a directory whose only chat has sub-agents still counts as ONE chat (#58)", () => {
  // The count that decides whether a chat header is redundant must exclude
  // sub-agents. Counting them would make a solo chat look like a shared
  // directory and the redundant header would come straight back.
  const agents = [a("solo", "/p/teapot"), a("sub-1", "", "solo"), a("sub-2", "", "solo")];
  assert.equal(wsChatCountsOf(agents).get("/p/teapot"), 1, "sub-agents must not inflate the count (#58)");
  const chatHeaders = sidebarRowsOf(agents, treeRowsOf(agents)).filter((r) => r.chatHeader !== undefined);
  assert.deepEqual(chatHeaders, [], "a chat with sub-agents is still a solo chat (#58)");
});

test("a sub-agent inherits its parent's workspace and group (#18)", () => {
  const agents = [a("solo", "/p/teapot"), a("sub", "", "solo")];
  assert.equal(workspaceOf(agents, "sub"), "/p/teapot", "a sub-agent joins its parent's directory (#18)");
  assert.equal(chatGroupKeyOf(agents, agents[1]!), "chat:solo", "and its parent's group (#18)");
});

test("a sub-tree collapses as one under its parent's chat (#18)", () => {
  const agents = [a("bugfix", "/p/teapot"), a("review", "/p/teapot"), a("sub-1", "", "bugfix")];
  const rows = sidebarRowsOf(agents, treeRowsOf(agents), new Set(["chat:bugfix"]));
  const visible = rows.filter((r) => !r.headerOnly).map((r) => r.a.id);
  assert.deepEqual(visible, ["review"], "the sub-agent hides with its parent (#18)");
});

/* ---------- degenerate input never throws ---------- */

test("an agent with no workspace gets no group header at all (#58)", () => {
  const agents = [a("nowhere", "")];
  const rows = sidebarRowsOf(agents, treeRowsOf(agents));
  assert.deepEqual(
    rows.filter((r) => r.headerOnly),
    [],
    "a chat with no workspace must not produce an empty header (#58)",
  );
  assert.equal(rows.length, 1, "but the chat itself is still listed (#58)");
});

test("a parent cycle does not hang the walk (#18)", () => {
  const agents = [a("x", "/p", "y"), a("y", "/p", "x")];
  assert.doesNotThrow(() => sidebarRowsOf(agents, treeRowsOf(agents)));
  assert.doesNotThrow(() => workspaceOf(agents, "x"));
  assert.doesNotThrow(() => chatGroupKeyOf(agents, agents[0]!));
});

/* ---------- wiring: App.tsx must really delegate ---------- */

test("App.tsx delegates the tree and grouping to the tested module (#58)", () => {
  srcHas("the tree must come from the tested module (#58)", /treeRowsOf\(agents\(\), collapsedSubs\(\), hideGhosts\(\)\)/);
  srcHas("the sidebar rows must come from the tested module (#58)", /sidebarRowsOf\(agents\(\), treeRows\(\), wsCollapsed\(\)\)/);
  srcHas("the workspace lookup must come from the tested module (#58)", /workspaceOfPure\(agents\(\), id\)/);
  srcHas("the chat key must come from the tested module (#18)", /chatGroupKeyOf\(agents\(\), a\)/);
  srcHas("the directory count must come from the tested module (#58)", /wsChatCountsOf\(agents\(\)\)/);
});

test("the chat-header row is still rendered when it exists (#18)", () => {
  // #58 removed the header from the SOLO case; the shared case must keep it,
  // or the two chats in one directory would lose their separate identities.
  srcHas("the chat header must remain in the DOM (#18)", /class="chatheader"/);
});
