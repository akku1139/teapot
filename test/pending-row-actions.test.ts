import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const _css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

import { groupedWith } from "../frontend/lib/row-grouping.ts";

const SENT = { type: "prompt", data: { source: "user", promptId: "u1" } };
const PENDING = { type: "prompt", data: { source: "user", promptId: "u2", pending: true } };

test("a queued message following a sent one does NOT group (#49)", () => {
  assert.equal(
    groupedWith(SENT, PENDING),
    false,
    "grouping hides the msg-head, which holds the ✕ cancel — the queued row " +
      "would be un-actionable (#49)",
  );
});

test("a queued message never groups, whatever precedes it (#49)", () => {
  const cases = [
    { type: "message", data: { role: "assistant", content: "hi" } },
    { type: "prompt", data: { source: "user", text: "older" } },
    { type: "tool_call", data: { name: "bash" } },
  ];
  for (const prev of cases) {
    assert.equal(
      groupedWith(prev, PENDING),
      false,
      `a queued row must never group (prev was ${prev.type}) (#49)`,
    );
  }
});

test("an already-grouped sent row still groups with its neighbour (#49)", () => {
  assert.equal(
    groupedWith(SENT, { type: "prompt", data: { source: "user", promptId: "u3" } }),
    true,
    "normal grouping of settled rows must be preserved (#49)",
  );
});

test("a withdrawn row does not group either (#49)", () => {
  assert.equal(
    groupedWith(SENT, { type: "prompt", data: { source: "user", cancelled: true } }),
    false,
    "a withdrawn row keeps its own header (#49)",
  );
});

