import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sidebarRowsOf, treeRowsOf, workspaceOf } from "../frontend/lib/sidebar-tree.ts";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const tree = readFileSync(new URL("../frontend/lib/sidebar-tree.ts", import.meta.url), "utf8");
function treeHas(label: string, re: RegExp): void {
  if (!re.test(tree)) assert.fail(`${label}\n  expected sidebar-tree.ts to match: ${re}`);
}
function srcHas(label: string, re: RegExp): void {
  if (!re.test(app)) assert.fail(`${label}\n  expected source to match: ${re}`);
}

interface A {
  id: string;
  parent: string;
  workspace: string;
}

function rowsFor(agents: A[], collapsed: Set<string> = new Set()) {
  return sidebarRowsOf(agents, treeRowsOf(agents, new Set(), false, new Set()), collapsed);
}

const chatIds = (agents: A[], collapsed?: Set<string>) =>
  rowsFor(agents, collapsed)
    .filter((r) => !r.headerOnly)
    .map((r) => r.a.id);

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

test("a collapsed workspace group renders no chats (#18)", () => {
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

test("sidebarRows reads the collapsed set (the click was a no-op) (#18)", () => {
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
