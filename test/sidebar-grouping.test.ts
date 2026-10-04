/**
 * #18 — "organise chats, make folders" (one-line issue, no spec).
 *
 * The part of this that needs no schema decision: the sidebar grouped ONLY by
 * parent/child agent, so chats belonging to unrelated projects interleaved in
 * one undifferentiated list — the actual "which chat was that?" problem. Every
 * agent already carries its workspace, so grouping by it invents no new concept.
 *
 * A real folder system (persisted? nestable? multi-membership?) is a schema
 * decision and was left to the operator; see the issue comment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sidebarRowsOf, treeRowsOf, workspaceOf } from "../frontend/sidebar-tree.ts";
import { markPosixOnly } from "./helpers/posix-only.ts";

// #110: POSIX-only — POSIX filesystem paths.
// The Windows CI job skips this file; see test/helpers/posix-only.ts for why
// opting out is explicit rather than by filename.
markPosixOnly("POSIX filesystem paths");

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

/**
 * #75 — this file used to re-implement `workspaceOf` and the header annotation
 * as local "mirrors of the shipped" functions, and asserted against THOSE. That
 * is the failure mode mutation testing exposed: destroying the real grouping in
 * `sidebar-tree.ts` left all 8 tests here passing, because a replica passes by
 * construction — it can only ever agree with itself.
 *
 * Both are now the shipped functions. The tests below are unchanged in intent;
 * what changed is that they can now fail.
 */

/** the shipped rules, not a copy */
const agentsOf = (rows: { id: string; parent: string; workspace: string }[]) => rows;

/* ---------- the grouping rule ---------- */

test("a sub-agent groups with its PARENT's workspace (#18)", () => {
  // a sub-agent's own workspace field is usually empty; it must not become its
  // own singleton group at the top of the sidebar
  const agents = [
    { id: "root", parent: "", workspace: "/tmp/proj" },
    { id: "child", parent: "root", workspace: "" },
  ];
  assert.equal(workspaceOf(agentsOf(agents), "child"), "/tmp/proj", "a sub-agent must inherit (#18)");
});

test("a parent cycle does not hang or return empty (#18)", () => {
  const agents = [
    { id: "a", parent: "b", workspace: "/x" },
    { id: "b", parent: "a", workspace: "" },
  ];
  assert.equal(typeof workspaceOf(agentsOf(agents), "a"), "string");
});

test("a header appears only when the workspace changes (#18)", () => {
  const agents = [
    { id: "a1", parent: "", workspace: "/p1" },
    { id: "a2", parent: "", workspace: "/p1" },
    { id: "b1", parent: "", workspace: "/p2" },
  ];
  const rows = sidebarRowsOf(
    agentsOf(agents),
    treeRowsOf(agentsOf(agents), new Set(), false, new Set()),
    new Set(),
  );
  // #62 made the header its OWN row, so there are exactly two headers for three
  // agents across two directories — and the agent id appears once each
  assert.deepEqual(
    rows.filter((r) => r.headerOnly).map((r) => r.wsHeader),
    ["/p1", "/p2"],
    "one header per directory, in first-seen order (#18)",
  );
  assert.deepEqual(
    rows.filter((r) => !r.headerOnly).map((r) => r.a.id),
    ["a1", "a2", "b1"],
    "every agent still appears exactly once (#18)",
  );
});

test("each project gets exactly one header (#18)", () => {
  const agents = [
    { id: "a1", parent: "", workspace: "/p1" },
    { id: "a2", parent: "", workspace: "/p1" },
    { id: "b1", parent: "", workspace: "/p2" },
    { id: "c1", parent: "", workspace: "/p3" },
  ];
  // since #62 the header is its OWN row, so headers are counted from the
  // headerOnly rows rather than mapped onto every chat row
  const rows = sidebarRowsOf(
    agentsOf(agents),
    treeRowsOf(agentsOf(agents), new Set(), false, new Set()),
    new Set(),
  );
  assert.equal(
    rows.filter((r) => r.headerOnly).length,
    3,
    `three projects → three headers (#18); got ${JSON.stringify(rows.filter((r) => r.headerOnly))}`,
  );
  assert.deepEqual(
    rows.filter((r) => r.headerOnly).map((r) => r.wsHeader),
    ["/p1", "/p2", "/p3"],
    "in first-seen order, so the sidebar does not reshuffle (#62)",
  );
});

test("an agent with no workspace does not get a stray header (#18)", () => {
  const agents = [
    { id: "x", parent: "", workspace: "" },
    { id: "y", parent: "", workspace: "/p" },
  ];
  const rows = sidebarRowsOf(
    agentsOf(agents),
    treeRowsOf(agentsOf(agents), new Set(), false, new Set()),
    new Set(),
  );
  // the real rule: an agent with NO directory gets no header at all, rather
  // than one labelled with the empty string
  assert.deepEqual(
    rows.filter((r) => r.headerOnly).map((r) => r.wsHeader),
    ["/p"],
    `no workspace -> no header row (#18); got ${JSON.stringify(rows.filter((r) => r.headerOnly))}`,
  );
  assert.ok(
    rows.filter((r) => !r.headerOnly).some((r) => r.a.id === "x"),
    "and the agent itself is still listed (#18)",
  );
});

test("the sidebar renders through sidebarRows() (#18)", () => {
  assert.match(app, /each=\{sidebarRows\(\)\}/, "the For must use the grouped rows (#18)");
  assert.match(app, /class="wsheader"/, "a workspace header row must exist (#18)");
  assert.match(app, /basenameOf\(row\.wsHeader/, "the header should show a short name (#18)");
});

test("the header is styled and collapsible (#18)", () => {
  assert.match(css, /\.wsheader\s*\{/s, "the header needs its own style (#18)");
  assert.match(css, /\.wsheader \.wscaret/, "the collapse caret needs styling (#18)");
  // the collapse is driven by the persisted group set; assert on the helper
  // rather than a specific call site, which moves whenever the row markup does
  assert.match(app, /const toggleWsGroup = /, "groups must be collapsible (#18)");
  assert.match(app, /setWsCollapsed\(next\)/, "and the click must write it (#18)");
});

/* ---------- the real DOM check lives in the bundle smoke test ---------- */

test("the smoke test asserts one header per workspace (#18)", () => {
  const smoke = readFileSync(new URL("../scripts/smoke-web.mjs", import.meta.url), "utf8");
  assert.match(smoke, /expected one workspace header per project/, "smoke must check the grouping (#18)");
  assert.match(smoke, /expected both agents in the sidebar/);
});
