/**
 * #18 follow-up — "some top-level chat dirs exist in the same working
 *        directory but are separate", and then the second half of that idea:
 *        the chat level it produced was one row too many.
 *
 * The first fix keyed each top-level chat as its own GROUP — correctly, since
 * two chats sharing a directory must be independently collapsible. It gave
 * that group its own HEADER row, so the tree ended up with two header levels:
 *
 *     ▾ TEAPOT            <- workspace header (directory)
 *       ▾ teapot          <- chat header
 *         teapot          <- the chat row
 *       ▾ teapot-2
 *         teapot-2
 *
 * Every chat named twice, and a directory with six chats rendered thirteen rows
 * for six conversations. A second pass removed the redundant header for SOLO
 * chats only, which fixed the one-chat-per-project case and left this one.
 *
 * The chat level is now gone entirely. What it bought — per-chat collapse that
 * leaves siblings alone — needs no header of its own, because a top-level chat
 * IS an agent row and its sub-agents already hang beneath it. So the row
 * carries the caret, exactly as a sub-agent's does, and `chat:<id>` remains the
 * group key so an existing collapse still applies after a reload.
 *
 * These tests import the real module. The point of extracting it was that the
 * earlier structural assertions here were source-text matches and a hand-rolled
 * replica — both of which pass by construction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  treeRowsOf,
  sidebarRowsOf,
  workspaceOf,
  chatGroupKeyOf,
  type TreeAgent,
} from "../frontend/sidebar-tree.ts";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

const a = (id: string, workspace: string, parent = ""): TreeAgent => ({ id, workspace, parent });

/** the full render, using the SAME two calls App.tsx makes */
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

/* ---------- the reported shape ---------- */

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
  // the specific complaint: a caret row reading `teapot` directly above a row
  // reading `teapot`. The directory header's LABEL is the basename, so compare
  // against the full path to be sure we are not matching on "teapot" twice.
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
  // the label the UI shows for that header is the basename, once
  assert.match(
    app,
    /basenameOf\(row\.wsHeader/,
    "the directory header keeps the short name (#18)",
  );
});

/* ---------- what the chat level bought, still works ---------- */

test("two chats in one directory stay separately collapsible (#18)", () => {
  const agents = [a("bugfix", "/p/teapot"), a("review", "/p/teapot"), a("elsewhere", "/p/other")];
  const rows = render(agents, new Set(["chat:bugfix"]));
  const vis = visible(rows);
  // the collapsed chat KEEPS a row — marked collapsed — because with the chat
  // header gone that row is the only control that can reopen it
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
  // and its header survives so it can be reopened
  const rows = render(agents, new Set(["ws:/p/teapot"]));
  assert.equal(rows.length, 1, "a collapsed directory keeps its header (#18)");
  assert.equal(rows[0]!.wsCollapsedGroup, true);
});

test("directory and chat collapse compose independently (#18)", () => {
  const agents = [a("a", "/p/one"), a("b", "/p/one"), a("c", "/p/two")];
  // a collapsed DIRECTORY still hides every row under it, including a chat
  // that is itself collapsed — the directory is the outer group
  assert.deepEqual(visible(render(agents, new Set(["ws:/p/one", "chat:b"]))), ["c"]);
});

/* ---------- sub-agents still behave as before ---------- */

test("a sub-agent with children collapses just that subtree (#18)", () => {
  // NOTE: collapsing a LEAF sub-agent is a no-op, and always has been — there
  // is nothing under it to hide. The caret only renders for a row that has
  // children, so this was verified as pre-existing behaviour rather than
  // assumed: v0.24.2's treeRowsOf emits the same rows for the same input.
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

/* ---------- inheritance and degenerate input ---------- */

test("a sub-agent inherits its parent's directory and indent (#18)", () => {
  const agents = [a("parent", "/p/teapot"), a("kid", "", "parent")];
  assert.equal(workspaceOf(agents, "kid"), "/p/teapot");
  const kid = render(agents).find((r) => !r.headerOnly && r.a.id === "kid");
  assert.equal(kid?.depth, 1, "a sub-agent is indented one level (#18)");
});

test("a chat with no workspace still lists, with no header (#18)", () => {
  // an empty path is not a directory: grouping on it would produce a header
  // labelled "", which is the cosmetic bug #58 fixed
  const rows = render([a("nowhere", "")]);
  assert.equal(rows.length, 1, "the chat must still be listed (#18)");
  assert.equal(rows[0]!.a.id, "nowhere");
  assert.equal(rows[0]!.wsHeader, undefined, "no empty directory header (#18)");
});

test("an empty agent list renders nothing (#18)", () => {
  assert.deepEqual(render([]), []);
});

/* ---------- wiring ---------- */

test("the chat header element and its CSS are gone (#18)", () => {
  assert.doesNotMatch(app, /class="chatheader"/, "the chat header row must not be rendered (#18)");
  assert.doesNotMatch(css, /\.chatheader/, "and its styles must go with it (#18)");
});

test("a top-level chat row gets a collapse caret (#18)", () => {
  // the capability now lives on the row, so the row must be able to collapse
  assert.match(app, /toggleWsGroup\(`chat:\$\{row\.a\.id\}`, row\.a\.id, off\)/, "its caret must toggle the chat group (#18)");
});

// #106 narrowed this rule, so the gate itself is asserted where it can actually
// be exercised — as a pure function over all four states, including the strand
// state a bundle check cannot reach. See test/sidebar-caret-gate.test.ts.
//
// What remains here is the part that IS about the tree: a leaf sub-agent still
// gets the spacer, so rows stay aligned, and the fallback is still wired.
test("the caret fallback keeps leaf rows aligned (#18)", () => {
  const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  assert.match(
    app,
    /fallback=\{<span class="caret-spacer" \/>\}/,
    "leaf sub-agents keep the spacer so rows stay aligned (#18)",
  );
  assert.match(
    app,
    /when=\{shouldShowCollapseCaret\(\{/,
    "the gate must be the shared helper (#106)",
  );
});

test("a childless chat round-trips through collapse (#18)", () => {
  const agents = [a("solo", "/p/teapot"), a("other", "/p/teapot")];
  assert.deepEqual(visible(render(agents)), ["solo", "other"], "expanded (#18)");
  const collapsed = render(agents, new Set(["chat:solo"]));
  const row = collapsed.find((r) => !r.headerOnly && r.a.id === "solo");
  assert.ok(row, "collapsed: the row must still exist to carry the caret (#18)");
  assert.equal(row!.chatCollapsedGroup, true);
  // expanding is the same call with the key gone
  assert.deepEqual(visible(render(agents)), ["solo", "other"], "expanded again: it returns (#18)");
});

test("chat collapse shares the PERSISTED group set, so a reload keeps it (#18)", () => {
  // the whole point of keeping `chat:<id>` as the key
  assert.match(app, /const chatCollapsed = createMemo<Set<string>>/, "derived from wsCollapsed (#18)");
  assert.match(app, /k\.startsWith\("chat:"\)/, "the chat: keys are reused, not new state (#18)");
});

test("a collapsed chat is NEVER removed from the tree (#18)", () => {
  // THE strand-a-chat guard. With the `chat:<id>` header deleted, the row is the
  // only control that can reopen the chat: hide the row too and nothing on
  // screen clears the stored key, so the chat is gone for the rest of the
  // session and across reloads. This is the bug ec8282a fixed for the old
  // header, and deleting the header without this reintroduced it.
  const agents = [a("alpha", "/p/one"), a("gamma", "/p/one"), a("alpha-sub", "", "alpha")];
  const rows = render(agents, new Set(["chat:alpha"]));
  const row = rows.find((r) => !r.headerOnly && r.a.id === "alpha");
  assert.ok(row, "the collapsed chat must still have a row (#18)");
  assert.equal(row!.chatCollapsedGroup, true, "and be marked collapsed (#18)");
  assert.ok(
    !rows.some((r) => !r.headerOnly && r.a.id === "alpha-sub"),
    "its sub-agents are what the collapse hides (#18)",
  );
  // and its sibling, in the same directory, is untouched
  assert.ok(rows.some((r) => !r.headerOnly && r.a.id === "gamma"), "gamma stays (#18)");
});

test("a collapsed chat's row is still selectable, and selects without expanding (#18/#66/#85)", () => {
  const app2 = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
  const css2 = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

  // This assertion used to require the row to be UNSELECTABLE while collapsed,
  // on the reasoning that "it is not a live row". That was wrong, and #66 is the
  // report: with every chat collapsed you could not get into any of them,
  // because the only way back was the ~9px caret on a row that looked inert.
  //
  // A collapsed chat is a normal chat that happens to be CLOSED, and it must be
  // selectable — what made it read as unselectable was its APPEARANCE
  // (`opacity: .5` + `cursor: default`), fixed in the CSS.
  assert.match(
    app2,
    /onclick=\{\(\) => select\(row\.a\.id\)\}/,
    "a collapsed chat must be selectable (#66)",
  );
  assert.doesNotMatch(
    app2,
    /onclick=\{\(\) => \{ if \(!row\.chatCollapsedGroup\) select\(row\.a\.id\); \}\}/,
    "a collapsed chat must not be a dead entry (#66)",
  );
  // #85: and selecting must NOT force the subtree open. An earlier version of
  // #66's fix did expand on select, which is the over-correction this corrects:
  // the collapse state is the operator's, not the click's.
  assert.doesNotMatch(
    app2,
    /if \(row\.chatCollapsedGroup\) toggleWsGroup/,
    "the row click must not expand the chat (#85)",
  );
  // the caret is still the control that toggles it.
  //
  // #81 wrapped this call in a block that also clears the OTHER collapse store,
  // so the literal one-liner no longer matches. The behaviour — the caret is the
  // control, and it toggles the chat group — is what matters, so assert that
  // rather than the shape.
  assert.match(
    app2,
    /toggleWsGroup\(`chat:\$\{row\.a\.id\}`, row\.a\.id, off\)/,
    "the caret must remain the expand control (#85)",
  );

  // it still READS as closed — via the caret, not by fading out (#66)
  assert.match(css2, /\.agent-item\.collapsed \{/, "and must read as collapsed (#66)");
  assert.match(
    css2,
    /\.agent-item\.collapsed \{[^}]*cursor:\s*pointer/,
    "a collapsed chat must still invite the click that opens it (#66)",
  );

  // the Show guard must not filter collapsed CHATS away — only the directory
  // header still hides its rows
  assert.match(
    app2,
    /<Show when=\{!row\.headerOnly && !row\.wsCollapsedGroup\}>/,
    "a collapsed chat's row must survive the render guard (#18)",
  );
});

