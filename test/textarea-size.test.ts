import { test } from "node:test";
import assert from "node:assert/strict";
import { rememberTextareaHeight, storedTextareaHeight } from "../frontend/lib/textarea-size.ts";

/**
 * A dragged panel height must survive a reload, and a panel must not inherit another's.
 *
 * Asked as "goalの枠をtodoみたいに伸縮できるようにしないと長いgoalがあるときに画面占有率が強制的に高い".
 * The goal box was a fixed `rows={3}`; the todo editor already had the drag, but its height was
 * keyed to one element. Sharing the mechanism is what this module is for, and sharing it wrongly —
 * one storage key for every panel — would make resizing the goal also resize the todo.
 */
test("a remembered height comes back, rounded, and is per-panel (#textarea)", () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  try {
    assert.equal(storedTextareaHeight("goal"), 0, "an untouched panel reports 0, so its rows win");

    rememberTextareaHeight("goal", 182.6);
    assert.equal(storedTextareaHeight("goal"), 183, "a dragged height is stored rounded");

    // per-panel: resizing the goal must not move the todo
    assert.equal(
      storedTextareaHeight("todo"),
      0,
      "panels must not share a key — one drag would resize every panel on the page",
    );
    rememberTextareaHeight("todo", 300);
    assert.equal(storedTextareaHeight("goal"), 183, "and the other direction too");

    // a corrupt value must not become the height (that would collapse the panel to nothing)
    store.set("teapot.textareaH.goal", "not-a-number");
    assert.equal(storedTextareaHeight("goal"), 0, "garbage is treated as untouched");
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
