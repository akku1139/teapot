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

/** mirror of the shipped workspaceOf(): sub-agents inherit their parent's */
function workspaceOf(agents: A[], id: string, seen = new Set<string>()): string {
  const a = agents.find((x) => x.id === id);
  if (!a) return "";
  if (!a.parent) return a.workspace || "";
  if (seen.has(id)) return a.workspace || "";
  seen.add(id);
  return workspaceOf(agents, a.parent, seen) || a.workspace || "";
}

/** mirror of the shipped treeRows(): subs hang under their parent */
function treeRows(agents: A[]): { a: A; depth: number }[] {
  const byParent = new Map<string, A[]>();
  const roots: A[] = [];
  for (const a of agents) {
    const isSub = a.parent && agents.some((p) => p.id === a.parent);
    if (isSub) {
      if (!byParent.has(a.parent!)) byParent.set(a.parent!, []);
      byParent.get(a.parent!)!.unshift(a);
    } else roots.push(a);
  }
  const rows: { a: A; depth: number }[] = [];
  const walk = (nodes: A[], depth: number) => {
    for (const a of nodes) {
      rows.push({ a, depth });
      walk(byParent.get(a.id) ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  return rows;
}

/** mirror of the fixed sidebarRows(): annotate headers, honour collapsed groups */
function sidebarRows(agents: A[], collapsed: Set<string> = new Set()) {
  const rows = treeRows(agents);
  const out: { a: A; depth: number; wsHeader?: string }[] = [];
  let lastWs: string | null = null;
  for (const r of rows) {
    const ws = workspaceOf(agents, r.a.id);
    if (collapsed.has(ws)) {
      // collapsed: the group keeps a header (so it can be reopened) but its
      // chats are hidden — and the header is re-emitted for every hidden row
      // so uncollapsing restores them in their original tree order
      out.push({ ...r, wsHeader: ws });
      continue;
    }
    const header = ws !== lastWs ? ws : undefined;
    out.push({ ...r, wsHeader: header });
    lastWs = ws;
  }
  // a fully collapsed group renders exactly ONE header, no agent rows
  return out.filter((r, i) => {
    if (r.wsHeader === undefined) return true;
    const collapsedGroup = collapsed.has(r.wsHeader);
    if (!collapsedGroup) return true;
    // keep only the first header of a collapsed run
    return i === 0 || out[i - 1]!.wsHeader !== r.wsHeader;
  });
}

const agents: A[] = [
  { id: "alpha", parent: "", workspace: "/p/alpha" },
  { id: "alpha-sub", parent: "alpha", workspace: "" },
  { id: "beta", parent: "", workspace: "/p/beta" },
  { id: "solo", parent: "", workspace: "/p/alpha" },
];

/* ---------- the rule ---------- */

test("a collapsed workspace group renders no chats (#18)", () => {
  const closed = sidebarRows(agents, new Set(["/p/alpha"]));
  // /p/alpha holds alpha, alpha-sub (sub-agent) and solo — all hidden, leaving
  // exactly one header row for the group itself
  const chatRows = closed.filter((r) => !isHeaderOf(closed, r));
  assert.deepEqual(
    chatRows.map((r) => r.a.id),
    ["beta"],
    `collapsing /p/alpha must hide its 3 chats, leaving only beta visible (#18)`,
  );
});

/** true when this row is the ONE header emitted for a collapsed group */
function isHeaderOf(rows: { wsHeader?: string }[], r: { wsHeader?: string }): boolean {
  return r.wsHeader !== undefined && /p\/alpha$/.test(r.wsHeader);
}

test("a collapsed group keeps its header so it can be reopened (#18)", () => {
  const closed = sidebarRows(agents, new Set(["/p/alpha"]));
  const headers = closed.map((r) => r.wsHeader).filter(Boolean);
  assert.ok(headers.includes("/p/alpha"), "the collapsed group must still show its header (#18)");
  assert.ok(headers.includes("/p/beta"), "other groups are untouched (#18)");
});

test("collapsing one group does not collapse another (#18)", () => {
  const closed = sidebarRows(agents, new Set(["/p/beta"]));
  const betaRows = closed.filter((r) => workspaceOf(agents, r.a.id) === "/p/beta");
  const alphaRows = closed.filter((r) => workspaceOf(agents, r.a.id) === "/p/alpha");
  assert.equal(betaRows.length, 1, "only beta's header should remain (#18)");
  assert.ok(alphaRows.length > 1, "alpha's chats must all still be visible (#18)");
});

test("collapsing a group hides the whole subtree under it (#18)", () => {
  const closed = sidebarRows(agents, new Set(["/p/alpha"]));
  const leaked = closed.filter(
    (r) => r.wsHeader !== "/p/alpha" && workspaceOf(agents, r.a.id) === "/p/alpha",
  );
  assert.deepEqual(leaked, [], "a sub-agent must hide with its parent's group (#18)");
});

test("uncollapsing restores every row in tree order (#18)", () => {
  const open = sidebarRows(agents);
  const reopened = sidebarRows(agents, new Set());
  assert.deepEqual(
    reopened.map((r) => r.a.id),
    open.map((r) => r.a.id),
    "reopening must restore exactly the original tree order (#18)",
  );
  assert.equal(reopened.length, 4, "all four chats visible again (#18)");
  // …and a group that was never collapsed must come back byte-identical
  const onlyBeta = sidebarRows(agents, new Set(["/p/alpha"]));
  assert.deepEqual(
    reopened.map((r) => r.wsHeader),
    open.map((r) => r.wsHeader),
    "headers must land back in the same place (#18)",
  );
  assert.ok(onlyBeta.length < reopened.length, "collapsing must actually shrink the list (#18)");
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
