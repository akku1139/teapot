/**
 * The sidebar workspace GROUP is only a header row (#18): clicking it flipped a
 * caret glyph, but nothing ever read the collapsed set — `sidebarRows()`
 * returned every tree row regardless, so the click was a pure visual no-op.
 * The user report: "the top-level directories are always expanded and do not
 * collapse when clicked".
 *
 * These tests mirror sidebarRows() exactly and pin the rule: a row belonging
 * to a collapsed workspace group is dropped from the list (its subtree with
 * it), and the collapsed group keeps a header row so it can be reopened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sidebarRowsOf, treeRowsOf, workspaceOf } from "../frontend/sidebar-tree.ts";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
// #58 moved the row-building rules into ./sidebar-tree so they could be unit
// tested; the wiring assertion below follows the code to its new home.
const tree = readFileSync(new URL("../frontend/sidebar-tree.ts", import.meta.url), "utf8");
function treeHas(label: string, re: RegExp): void {
  if (!re.test(tree)) assert.fail(`${label}\n  expected sidebar-tree.ts to match: ${re}`);
}
/** assert on a MATCH only — a failing source-text match otherwise dumps the
 *  whole 250KB component into the failure message and buries the point */
function srcHas(label: string, re: RegExp): void {
  if (!re.test(app)) assert.fail(`${label}\n  expected source to match: ${re}`);
}

interface A {
  id: string;
  parent: string;
  workspace: string;
}

/**
 * #75 — this file re-implemented `workspaceOf`, `treeRows` and `sidebarRows` as
 * local mirrors, and asserted against THOSE. Mutation testing proved the
 * consequence: disabling directory collapse entirely
 * (`if (false && collapsed.has(\`ws:${ws}\`))`) left all five behavioural tests
 * here PASSING, because a replica can only ever agree with itself.
 *
 * All three are now the shipped functions. The tests are unchanged in intent;
 * what changed is that they can fail.
 */
function rowsFor(agents: A[], collapsed: Set<string> = new Set()) {
  return sidebarRowsOf(agents, treeRowsOf(agents, new Set(), false, new Set()), collapsed);
}

/** the chat rows (headers excluded) */
const chatIds = (agents: A[], collapsed?: Set<string>) =>
  rowsFor(agents, collapsed)
    .filter((r) => !r.headerOnly)
    .map((r) => r.a.id);

/** the header labels, in order */
const headerLabels = (agents: A[], collapsed?: Set<string>) =>
  rowsFor(agents, collapsed)
    .filter((r) => r.headerOnly)
    .map((r) => r.wsHeader);

const agents: A[] = [
  { id: "alpha", parent: "", workspace: "/p/alpha" },
  { id: "alpha-sub", parent: "alpha", workspace: "" },
  { id: "beta", parent: "", workspace: "/p/beta" },
  { id: "solo", parent: "", workspace: "/p/alpha" },
];

/* ---------- the rule ---------- */

test("a collapsed workspace group renders no chats (#18)", () => {
  // /p/alpha holds alpha, alpha-sub (a sub-agent) and solo — all hidden,
  // leaving the one header row for the group itself
  assert.deepEqual(
    chatIds(agents, new Set(["ws:/p/alpha"])),
    ["beta"],
    "collapsing /p/alpha must hide its 3 chats, leaving only beta visible (#18)",
  );
  assert.deepEqual(headerLabels(agents, new Set(["ws:/p/alpha"])), ["/p/alpha", "/p/beta"]);
});

test("a collapsed group keeps its header so it can be reopened (#18)", () => {
  const headers = headerLabels(agents, new Set(["ws:/p/alpha"]));
  assert.ok(headers.includes("/p/alpha"), "the collapsed group must still show its header (#18)");
  assert.ok(headers.includes("/p/beta"), "other groups are untouched (#18)");
});

test("collapsing one group does not collapse another (#18)", () => {
  assert.deepEqual(
    chatIds(agents, new Set(["ws:/p/beta"])),
    ["alpha", "alpha-sub", "solo"],
    "collapsing /p/beta must hide ONLY beta (#18)",
  );
  assert.deepEqual(
    headerLabels(agents, new Set(["ws:/p/beta"])),
    ["/p/alpha", "/p/beta"],
    "and both group headers survive, so either can be reopened (#18)",
  );
});

test("collapsing a group hides the whole subtree under it (#18)", () => {
  const visible = chatIds(agents, new Set(["ws:/p/alpha"]));
  assert.ok(
    !visible.includes("alpha-sub"),
    `a sub-agent must hide with its parent's group (#18); leaked ${JSON.stringify(visible)}`,
  );
});

test("uncollapsing restores every row in tree order (#18)", () => {
  const open = chatIds(agents);
  const reopened = chatIds(agents, new Set());
  assert.deepEqual(reopened, open, "reopening must restore exactly the original tree order (#18)");
  assert.equal(reopened.length, 4, "all four chats visible again (#18)");
  assert.deepEqual(headerLabels(agents, new Set()), headerLabels(agents), "headers land back identically (#18)");
  const collapsed = chatIds(agents, new Set(["ws:/p/alpha"]));
  assert.ok(collapsed.length < reopened.length, "collapsing must actually shrink the list (#18)");
});

/* ---------- wiring: the set must actually be READ ---------- */

test("sidebarRows reads the collapsed set (the click was a no-op) (#18)", () => {
  // The regression, verbatim: the memo built every tree row and the collapsed
  // signal was written by the click handler but never READ, so the group could
  // not collapse. Assert the memo both reads the set AND filters on it.
  srcHas(
    "sidebarRows() must consult wsCollapsed() — otherwise clicking a header does nothing (#18)",
    /const sidebarRows = createMemo\(\(\) =>\s*sidebarRowsOf\(agents\(\), treeRows\(\), wsCollapsed\(\)\)/,
  );
  srcHas(
    "a collapsed group's chats must be filtered out of the row list (#18)",
    /wsCollapsedGroup/,
  );
  treeHas(
    "the row builder must actually drop the members of a collapsed group (#18)",
    /if \(collapsed\.has\(`ws:\$\{ws\}`\)\) continue;/,
  );
});

test("the header row is clickable and toggles the group (#18)", () => {
  srcHas("the header must toggle its group (#18)", /class="wsheader"[\s\S]{0,600}onclick=/);
  srcHas("toggling should go through one named helper (#18)", /toggleWsGroup\(/);
});
