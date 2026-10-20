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
import { treeRowsOf, sidebarRowsOf, descendantsOf } from "../frontend/sidebar-tree.ts";

interface A {
  id: string;
  parent?: string;
  workspace: string;
  workspaceMissing?: boolean;
}
const agent = (id: string, parent = ""): A => ({ id, parent, workspace: "/w", workspaceMissing: false });

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
