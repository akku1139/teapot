/**
 * #81 — "a session that HAS sub-agents shows none of them in the chat tree."
 *
 * Reported DOM (v0.26.11), which is what this reproduces:
 *
 *   <div class="agent-item">
 *     <span class="caret" title="hide teapot and its sub-agents">▾</span>
 *     ...<span class="subcount" title="8 sub-agents (0 active)">🧩 8</span>
 *   </div>
 *
 * An EXPANDED caret, a badge claiming 8 sub-agents, and not one child row.
 *
 * ## Cause
 *
 * A top-level chat's subtree is hidden by TWO different sets, and the caret only
 * read one of them:
 *
 *   - `chat:<id>` in `teapot.wsCollapsed` — what this caret WRITES;
 *   - the bare id in `teapot.collapsed` (`collapsedSubs`) — what `treeRowsOf`
 *     checks `collapsedSubs` to hide the children.
 *
 * Nothing in the current UI writes a bare top-level id into `teapot.collapsed`,
 * so such an entry can only predate it. `treeRowsOf` honoured it anyway, so a
 * stale entry hid the whole subtree while the caret claimed the chat was open.
 *
 * The badge made it worse rather than better: `descendantsOf()` consults neither
 * set, so it kept counting children that were hidden — hence 🧩8 with zero rows.
 *
 * The #18-era migration cleaned the equivalent keys out of `teapot.wsCollapsed`
 * but nothing ever cleaned this second store, which is why every previous fix for
 * this issue could pass while it stayed reproducible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { treeRowsOf, sidebarRowsOf, descendantsOf } from "../frontend/sidebar-tree.ts";

interface A {
  id: string;
  parent?: string;
  workspace: string;
  workspaceMissing?: boolean;
}
const agent = (id: string, parent = ""): A => ({ id, parent, workspace: "/w", workspaceMissing: false });

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");

/* ---------- the reported shape ---------- */

test("a stale collapsedSubs entry for a CHAT hides its subtree (#81)", () => {
  // precondition: this is genuinely what treeRowsOf does
  const agents = [agent("teapot"), ...["s1", "s2", "s3", "s4"].map((n) => agent(`teapot-sub-${n}`, "teapot"))];
  const rows = sidebarRowsOf(
    agents,
    treeRowsOf(agents, new Set(["teapot"]), false, new Set()), // stale entry
    new Set(),
  );
  const visible = rows.filter((r) => !r.headerOnly);
  assert.equal(
    visible.filter((r) => r.depth > 0).length,
    0,
    "precondition: a collapsedSubs entry for the chat hides every child (#81)",
  );
});

test("the badge still counts them, which is why it read 🧩8 with no rows (#81)", () => {
  const agents = [agent("teapot"), ...["s1", "s2", "s3", "s4"].map((n) => agent(`teapot-sub-${n}`, "teapot"))];
  assert.equal(
    descendantsOf(agents, "teapot").length,
    4,
    "descendantsOf consults neither collapse set, so it counts hidden children (#81)",
  );
});

/* ---------- the fix ---------- */

test("a top-level id in teapot.collapsed is dropped on load (#81)", () => {
  // nothing in the current UI writes a bare top-level id here, so it is a leftover
  const at = app.indexOf('localStorage.getItem("teapot.collapsed")');
  assert.notEqual(at, -1, "collapsedSubs must be loaded (#81)");
  // the comment between the read and the filter is ~10 lines, so a fixed 220-char
  // window stopped short of it — anchor on the whole IIFE instead
  const start = app.lastIndexOf("createSignal<Set<string>>", at);
  const block = app.slice(start, app.indexOf("})());", at));
  assert.match(
    block,
    /!k\.startsWith\("chat:"\)/,
    "a chat: key here is also stale and must go (#81)",
  );
  assert.match(
    block,
    /\.filter\(\(k\) => typeof k === "string"/,
    "and non-strings must not become Set members (#81)",
  );
});

test("sub-agent ids survive the load filter (#81)", () => {
  // the operator's own collapse state must not be thrown away with the leftovers
  const at = app.indexOf('localStorage.getItem("teapot.collapsed")');
  const start = app.lastIndexOf("createSignal<Set<string>>", at);
  const block = app.slice(start, app.indexOf("})());", at));
  assert.doesNotMatch(
    block,
    /\.filter\(\(k\) => !k\)/,
    "a sub-agent id MUST be kept — its caret writes here (#18)",
  );
});

test("the caret reads BOTH sets for a top-level chat (#81)", () => {
  // the contradiction: caret ▾ (open) while the subtree is hidden
  const at = app.indexOf("const off = isChat");
  assert.notEqual(at, -1, "the caret's off state must exist (#81)");
  const block = app.slice(at, app.indexOf(";", app.indexOf(": collapsedSubs().has(row.a.id);", at)));
  assert.match(
    block,
    /chatCollapsed\(\)\.has\(`chat:\$\{row\.a\.id\}`\)\s*\|\|\s*collapsedSubs\(\)\.has\(row\.a\.id\)/,
    "off must be true when EITHER set hides the chat (#81)",
  );
});

test("clicking the caret clears both stores (#81)", () => {
  // otherwise the caret points open at a still-hidden subtree
  const click = app.indexOf("onclick={(e: MouseEvent) => {", app.indexOf("const off = isChat"));
  assert.notEqual(click, -1, "the caret click handler must exist (#81)");
  const block = app.slice(click, app.indexOf("else toggleCollapse", click));
  assert.match(
    block,
    /collapsedSubs\(\)\.has\(row\.a\.id\)/,
    "the other store must be checked (#81)",
  );
  assert.match(
    block,
    /localStorage\.setItem\("teapot\.collapsed"/,
    "and persisted so it does not come back on reload (#81)",
  );
});

test("a SUB-AGENT's caret still reads only collapsedSubs (#81)", () => {
  // narrowing the fix to top-level chats: a sub-agent has no chat:<id> group
  const at = app.indexOf("const off = isChat");
  const block = app.slice(at, at + 260);
  assert.match(block, /: collapsedSubs\(\)\.has\(row\.a\.id\);/, "the sub-agent branch (#18)");
});