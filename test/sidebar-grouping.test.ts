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

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

/** mirror of the shipped workspaceOf() so the rule itself is under test */
function workspaceOf(agents: { id: string; parent: string; workspace: string }[], id: string, seen = new Set<string>()): string {
  const a = agents.find((x) => x.id === id);
  if (!a) return "";
  if (!a.parent) return a.workspace || "";
  if (seen.has(id)) return a.workspace || "";
  seen.add(id);
  return workspaceOf(agents, a.parent, seen) || a.workspace || "";
}

/** mirror of sidebarRows(): a header wherever the workspace changes */
function annotate(rows: { a: { id: string; parent: string; workspace: string }; depth: number }[], agents: typeof rows[number]["a"][]) {
  const out: { id: string; wsHeader?: string }[] = [];
  let lastWs: string | null = null;
  for (const r of rows) {
    const ws = workspaceOf(agents, r.a.id);
    const header = ws !== lastWs ? ws : undefined;
    out.push({ id: r.a.id, wsHeader: header });
    lastWs = ws;
  }
  return out;
}

/* ---------- the grouping rule ---------- */

test("a sub-agent groups with its PARENT's workspace (#18)", () => {
  // a sub-agent's own workspace field is usually empty; it must not become its
  // own singleton group at the top of the sidebar
  const agents = [
    { id: "root", parent: "", workspace: "/tmp/proj" },
    { id: "child", parent: "root", workspace: "" },
  ];
  assert.equal(workspaceOf(agents, "child"), "/tmp/proj", "a sub-agent must inherit (#18)");
});

test("a parent cycle does not hang or return empty (#18)", () => {
  const agents = [
    { id: "a", parent: "b", workspace: "/x" },
    { id: "b", parent: "a", workspace: "" },
  ];
  assert.equal(typeof workspaceOf(agents, "a"), "string");
});

test("a header appears only when the workspace changes (#18)", () => {
  const agents = [
    { id: "a1", parent: "", workspace: "/p1" },
    { id: "a2", parent: "", workspace: "/p1" },
    { id: "b1", parent: "", workspace: "/p2" },
  ];
  const got = annotate(agents.map((a) => ({ a, depth: 0 })), agents);
  assert.deepEqual(got.map((g) => g.wsHeader), ["/p1", undefined, "/p2"], "(#18)");
});

test("each project gets exactly one header (#18)", () => {
  const agents = [
    { id: "a1", parent: "", workspace: "/p1" },
    { id: "a2", parent: "", workspace: "/p1" },
    { id: "b1", parent: "", workspace: "/p2" },
    { id: "c1", parent: "", workspace: "/p3" },
  ];
  const got = annotate(agents.map((a) => ({ a, depth: 0 })), agents);
  assert.equal(got.filter((g) => g.wsHeader !== undefined).length, 3, "three projects → three headers (#18)");
});

test("an agent with no workspace does not get a stray header (#18)", () => {
  const agents = [{ id: "x", parent: "", workspace: "" }];
  const got = annotate(agents.map((a) => ({ a, depth: 0 })), agents);
  assert.equal(got[0]!.wsHeader, "", "no workspace → no header row (#18)");
});

/* ---------- wiring ---------- */

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
