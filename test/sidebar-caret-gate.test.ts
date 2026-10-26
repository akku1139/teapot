/**
 * #106 — "if there are no sub-agents, the expand button is not needed."
 *
 * A caret that collapses nothing is noise. But the naive fix — gate a chat's
 * caret on "has children" — reintroduces #18's strand-a-chat bug:
 *
 * Collapsing is what WRITES the `chat:<id>` key, so a chat can hold a STALE one
 * by two ordinary routes:
 *
 *   1. upgrade — every chat was collapsed under the old chat header, so every
 *      existing install starts with keys already set;
 *   2. a chat that HAD sub-agents, was collapsed, then lost them to disposal.
 *
 * In both, `sidebarRowsOf` still renders the row marked `chatCollapsedGroup`, so
 * it is on screen — but with no caret there is NO control to clear the key, and
 * the chat is stuck showing ▸ for good.
 *
 * So the caret shows exactly when it would do something, or when it is the only
 * way back out.
 *
 * ## Why this is a unit test and not a smoke check
 *
 * Reaching the strand state through the real bundle needs a childless chat that
 * is ALSO collapsed, and that requires the sub-agent to be GONE FROM `agents()` —
 * not merely hidden. `treeRowsOf` hides a collapsed chat's children while they
 * remain in the agent list, so removing the rendered row proves nothing and the
 * has-children branch still fires. Driving that through the poller took ~11s of
 * timing-dependent DOM work and the mutation still survived.
 *
 * The gate is a pure function of three booleans, so it is tested directly. That
 * is deterministic and fails on the mutation, which is what matters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldShowCollapseCaret } from "../frontend/lib/sidebar-tree.ts";

/** the reported case: no sub-agents, not collapsed -> no caret */
test("a childless EXPANDED chat shows no caret (#106)", () => {
  assert.equal(
    shouldShowCollapseCaret({ isSub: false, collapsed: false, hasChildren: false }),
    false,
    "the reported case: the button is not needed (#106)",
  );
});

/** the strand state: childless but COLLAPSED -> the caret is the only way out */
test("a childless COLLAPSED chat KEEPS its caret (#18/#106)", () => {
  assert.equal(
    shouldShowCollapseCaret({ isSub: false, collapsed: true, hasChildren: false }),
    true,
    "without this the stale key strands the chat (#106)",
  );
});

test("a chat with sub-agents shows the caret (#106)", () => {
  assert.equal(
    shouldShowCollapseCaret({ isSub: false, collapsed: false, hasChildren: true }),
    true,
    "it collapses something (#106)",
  );
  // and collapsed or not, a chat with children keeps it
  assert.equal(shouldShowCollapseCaret({ isSub: false, collapsed: true, hasChildren: true }), true);
});

test("a sub-agent shows the caret only when it has children (#18)", () => {
  assert.equal(
    shouldShowCollapseCaret({ isSub: true, collapsed: false, hasChildren: true }),
    true,
    "a leaf sub-agent still collapses its own subtree (#18)",
  );
  // a leaf sub-agent gets the spacer so rows stay aligned — unchanged by #106
  assert.equal(
    shouldShowCollapseCaret({ isSub: true, collapsed: false, hasChildren: false }),
    false,
    "leaf sub-agents keep the spacer (#18)",
  );
  // `collapsed` is deliberately ignored for a sub-agent: its group is not a chat
  // group, and a sub-agent with no children has nothing to collapse or reopen
  assert.equal(
    shouldShowCollapseCaret({ isSub: true, collapsed: true, hasChildren: false }),
    false,
    "the strand concern is about TOP-LEVEL chats only (#18)",
  );
});

/** the gate must not drift back to the old shape */
