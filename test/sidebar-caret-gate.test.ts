import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldShowCollapseCaret } from "../frontend/lib/sidebar-tree.ts";

test("a childless EXPANDED chat shows no caret (#106)", () => {
  assert.equal(
    shouldShowCollapseCaret({ isSub: false, collapsed: false, hasChildren: false }),
    false,
    "the reported case: the button is not needed (#106)",
  );
});

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
  assert.equal(shouldShowCollapseCaret({ isSub: false, collapsed: true, hasChildren: true }), true);
});

test("a sub-agent shows the caret only when it has children (#18)", () => {
  assert.equal(
    shouldShowCollapseCaret({ isSub: true, collapsed: false, hasChildren: true }),
    true,
    "a leaf sub-agent still collapses its own subtree (#18)",
  );
  assert.equal(
    shouldShowCollapseCaret({ isSub: true, collapsed: false, hasChildren: false }),
    false,
    "leaf sub-agents keep the spacer (#18)",
  );
  assert.equal(
    shouldShowCollapseCaret({ isSub: true, collapsed: true, hasChildren: false }),
    false,
    "the strand concern is about TOP-LEVEL chats only (#18)",
  );
});

