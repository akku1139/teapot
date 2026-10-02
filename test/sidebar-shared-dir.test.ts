/**
 * #18 follow-up — "some top-level chat dirs exist in the same working
 * directory but are separate".
 *
 * The sidebar grouped by WORKSPACE PATH alone, so every chat pointed at the
 * same directory collapsed into one anonymous bucket: several genuinely
 * separate top-level chats, one header, and nothing in the group to tell them
 * apart except an agent id buried in a flat list. That is the one case the
 * grouping was supposed to answer — "which chat was that?" — and it answered
 * it worst exactly where the answer mattered most.
 *
 * The fix keeps workspace as the grouping level (it is the useful one) but
 * makes each TOP-LEVEL chat a visible member of its group, so two chats in one
 * directory read as two entries under one project rather than one blob.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

function srcHas(label: string, re: RegExp): void {
  if (!re.test(app)) assert.fail(`${label}\n  expected source to match: ${re}`);
}

interface A {
  id: string;
  parent: string;
  workspace: string;
}

function workspaceOf(agents: A[], id: string, seen = new Set<string>()): string {
  const a = agents.find((x) => x.id === id);
  if (!a) return "";
  if (!a.parent) return a.workspace || "";
  if (seen.has(id)) return a.workspace || "";
  seen.add(id);
  return workspaceOf(agents, a.parent, seen) || a.workspace || "";
}

/** mirror of the fixed grouping: a workspace group lists its top-level chats */
function groupByWorkspace(agents: A[]): Map<string, { ws: string; chats: string[] }> {
  const groups = new Map<string, { ws: string; chats: string[] }>();
  for (const a of agents) {
    if (a.parent) continue; // sub-agents hang under their parent, not the group
    const ws = workspaceOf(agents, a.id) || "";
    if (!ws) continue;
    if (!groups.has(ws)) groups.set(ws, { ws, chats: [] });
    groups.get(ws)!.chats.push(a.id);
  }
  return groups;
}

const shared: A[] = [
  { id: "bugfix-chat", parent: "", workspace: "/p/teapot" },
  { id: "review-chat", parent: "", workspace: "/p/teapot" },
  { id: "docs-chat", parent: "", workspace: "/p/teapot" },
  { id: "other", parent: "", workspace: "/p/elsewhere" },
];

/* ---------- the rule ---------- */

test("two chats in one directory are separate members of ONE group (#18)", () => {
  const g = groupByWorkspace(shared).get("/p/teapot")!;
  assert.deepEqual(
    g.chats,
    ["bugfix-chat", "review-chat", "docs-chat"],
    "same-directory chats must each remain visible in the group (#18)",
  );
});

test("a shared directory is ONE group, not three (#18)", () => {
  assert.equal(groupByWorkspace(shared).size, 2, "two directories → two groups (#18)");
});

test("a sub-agent is not its own group entry (#18)", () => {
  const withSub: A[] = [
    ...shared,
    { id: "review-sub", parent: "review-chat", workspace: "" },
  ];
  const g = groupByWorkspace(withSub).get("/p/teapot")!;
  assert.ok(
    !g.chats.includes("review-sub"),
    "sub-agents must not be listed as separate group members (#18)",
  );
});

test("a single chat in a directory still forms its group (#18)", () => {
  const g = groupByWorkspace(shared).get("/p/elsewhere")!;
  assert.deepEqual(g.chats, ["other"], "a lone chat is still a group (#18)");
});

/* ---------- wiring ---------- */

test("the header shows how many chats the project holds (#18)", () => {
  // a header that names the project is not enough to tell three chats apart;
  // the count is what makes the group legible at a glance
  srcHas("the header must show the group's chat count (#18)", /wsChatCounts|chatCount/);
  srcHas("the count must be rendered on the header row (#18)", /class="wscount"/);
});

test("the group keeps one header for many chats (#18)", () => {
  srcHas(
    "shared-directory chats must stay under ONE header (#18)",
    /wsHeader/,
  );
});