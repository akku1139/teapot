/**
 * #18 follow-up — "some top-level chat dirs exist in the same working
 * directory but are separate."
 *
 * The first attempt at this added a COUNT BADGE and left the grouping keyed on
 * the workspace path. That says "there are 2 chats here" but still gives them
 * ONE group identity: one header, one collapse toggle, one row to hide. Two
 * genuinely separate chats still cannot be opened or hidden independently,
 * which is the thing the report asks for.
 *
 * The fix keys each top-level chat as its own group, identified by the chat
 * itself rather than the directory it happens to share with another. The shared
 * directory is still visible — it becomes the PARENT header, with the chats
 * nested under it — so the project grouping that motivated #18 survives while
 * the chats inside it become individually addressable.
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

/**
 * mirror of the fixed sidebarRows().
 *
 * Two header levels:
 *   - a WORKSPACE header whenever the directory changes (unchanged from #18),
 *   - a CHAT header for each TOP-LEVEL chat, so two chats sharing a directory
 *     are two separately collapsible groups rather than one shared bucket.
 */
function sidebarRows(
  agents: A[],
  collapsed: Set<string> = new Set(),
): { kind: "workspace" | "chat" | "agent"; key: string; id?: string }[] {
  const rows: { a: A; depth: number }[] = [];
  const byParent = new Map<string, A[]>();
  const roots: A[] = [];
  for (const a of agents) {
    if (a.parent && agents.some((p) => p.id === a.parent)) {
      if (!byParent.has(a.parent)) byParent.set(a.parent, []);
      byParent.get(a.parent)!.unshift(a);
    } else roots.push(a);
  }
  const walk = (nodes: A[], depth: number) => {
    for (const a of nodes) {
      rows.push({ a, depth });
      walk(byParent.get(a.id) ?? [], depth + 1);
    }
  };
  walk(roots, 0);

  const out: { kind: "workspace" | "chat" | "agent"; key: string; id?: string }[] = [];
  let lastWs: string | null = null;
  let lastGroup: string | null = null;
  for (const r of rows) {
    const ws = workspaceOf(agents, r.a.id);
    if (ws !== lastWs) {
      out.push({ kind: "workspace", key: `ws:${ws}` });
      lastWs = ws;
      lastGroup = null;
    }
    // each TOP-LEVEL chat is its own group
    if (!r.a.parent) {
      const key = `chat:${r.a.id}`;
      if (key !== lastGroup) out.push({ kind: "chat", key });
      lastGroup = key;
    }
    out.push({ kind: "agent", key: r.a.id, id: r.a.id });
  }
  // collapsed groups drop their member rows but keep their own header. A chat
  // row belongs to whichever group header most recently preceded it, and a
  // WORKSPACE collapse takes everything under it.
  return out.filter((row, i) => {
    if (row.kind !== "agent") return true;
    const chat = precedingKind(out, i, "chat");
    const ws = precedingKind(out, i, "workspace");
    return !(chat && collapsed.has(chat.key)) && !(ws && collapsed.has(ws.key));
  });
}

/** the nearest header of `kind` above row i, or null */
function precedingKind(
  rows: { kind: string; key: string }[],
  i: number,
  kind: string,
): { key: string } | null {
  for (let j = i - 1; j >= 0; j--) {
    if (rows[j]!.kind === kind) return rows[j]!;
    if (rows[j]!.kind === "workspace" && kind === "chat") return null;
  }
  return null;
}

const shared: A[] = [
  { id: "bugfix", parent: "", workspace: "/p/teapot" },
  { id: "review", parent: "", workspace: "/p/teapot" },
  { id: "elsewhere", parent: "", workspace: "/p/other" },
];

/* ---------- the rule ---------- */

test("two chats in one directory are SEPARATE groups (#18)", () => {
  const rows = sidebarRows(shared);
  const chatHeaders = rows.filter((r) => r.kind === "chat").map((r) => r.key);
  assert.deepEqual(
    chatHeaders,
    ["chat:bugfix", "chat:review", "chat:elsewhere"],
    "every top-level chat must be its own group (#18)",
  );
});

test("the shared directory still has ONE workspace header (#18)", () => {
  const wsHeaders = sidebarRows(shared).filter((r) => r.kind === "workspace").map((r) => r.key);
  assert.deepEqual(wsHeaders, ["ws:/p/teapot", "ws:/p/other"], "one header per directory (#18)");
});

test("collapsing one chat leaves its sibling alone (#18)", () => {
  const rows = sidebarRows(shared, new Set(["chat:bugfix"]));
  const visible = rows.filter((r) => r.kind === "agent").map((r) => r.key);
  assert.ok(!visible.includes("bugfix"), "the collapsed chat must be hidden (#18)");
  assert.ok(visible.includes("review"), "its sibling in the SAME directory must remain (#18)");
});

test("collapsing a chat keeps its header so it can be reopened (#18)", () => {
  const rows = sidebarRows(shared, new Set(["chat:bugfix"]));
  const keys = rows.map((r) => r.key);
  assert.ok(keys.includes("chat:bugfix"), "the collapsed chat's header must survive (#18)");
  assert.ok(keys.includes("chat:review"), "the sibling header must survive (#18)");
});

test("collapsing the WORKSPACE hides every chat under it (#18)", () => {
  const rows = sidebarRows(shared, new Set(["ws:/p/teapot"]));
  const visible = rows.filter((r) => r.kind === "agent").map((r) => r.key);
  assert.deepEqual(visible, ["elsewhere"], "the whole directory's chats go (#18)");
});

test("a sub-agent does not become its own chat group (#18)", () => {
  const rows = sidebarRows([
    ...shared,
    { id: "bugfix-sub", parent: "bugfix", workspace: "" },
  ]);
  const chatHeaders = rows.filter((r) => r.kind === "chat").map((r) => r.key);
  assert.ok(
    !chatHeaders.includes("chat:bugfix-sub"),
    "a sub-agent belongs to its parent's group (#18)",
  );
});

/* ---------- wiring ---------- */

test("the group key is the CHAT, not the workspace path (#18)", () => {
  // the defect: one group identity per directory, shared by every chat in it
  srcHas(
    "top-level chats must get their own group key (#18)",
    /`chat:\$\{id \|\| a\.id\}`/,
  );
  srcHas("the memo must key groups by chat (#18)", /const gkey = chatGroupKey\(r\.a\)/);
});

test("collapsing a chat hides only that chat (#18)", () => {
  srcHas(
    "the collapse check must use the CHAT key, not the directory (#18)",
    /collapsed\.has\(gkey\)/,
  );
  srcHas("a chat header must exist in the DOM (#18)", /class="chatheader"/);
});

test("a workspace header still exists above the chat headers (#18)", () => {
  srcHas("the project grouping must survive (#18)", /kind: "workspace"|wsHeader/);
});

/* ---------- the directory-level count, which survives as a summary -------- */

/**
 * The count badge stays, but as a SUMMARY of the directory rather than as a
 * substitute for separate identities. It answers "how much is in here" at a
 * glance while the chat headers answer "what exactly is in here".
 */
test("the workspace header summarises how many chats the directory holds (#18)", () => {
  srcHas("the directory count must still be computed (#18)", /wsChatCounts/);
  srcHas("the count must render on the workspace header (#18)", /class="wscount"/);
});

test("the count excludes sub-agents (#18)", () => {
  // a sub-agent already hangs under its parent chat header; counting it would
  // inflate "how many chats do I have here"
  srcHas("only top-level chats may be counted (#18)", /if \(a\.parent\) continue; \/\/ a sub-agent/);
});
