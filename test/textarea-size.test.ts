import { test } from "node:test";
import assert from "node:assert/strict";
import { rememberTextareaHeight, storedTextareaHeight } from "../frontend/lib/textarea-size.ts";

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

    assert.equal(
      storedTextareaHeight("todo"),
      0,
      "panels must not share a key — one drag would resize every panel on the page",
    );
    rememberTextareaHeight("todo", 300);
    assert.equal(storedTextareaHeight("goal"), 183, "and the other direction too");

    store.set("teapot.textareaH.goal", "not-a-number");
    assert.equal(storedTextareaHeight("goal"), 0, "garbage is treated as untouched");
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
