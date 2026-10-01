/**
 * #49 — "when a SENT message and a PENDING message line up on the timeline, you
 *         can no longer do anything with the latter"
 *
 * Two compounding defects, both invisible until a queued message happened to
 * sit directly below an already-sent one:
 *
 *  1. The row header — which CONTAINS the ✕ cancel button — is only rendered
 *     when the row is not `grouped`. `grouped` is true whenever the previous
 *     row shares the actor key and author, and a sent user prompt followed by a
 *     queued user prompt satisfies both. The queued row therefore lost its
 *     cancel affordance entirely and could not be withdrawn.
 *     Since #37 deliberately places pending echoes BELOW settled rows, "sent →
 *     pending" became the NORMAL case rather than a rare edge case.
 *
 *  2. `.msg-head .editbtn` is `opacity: 0` until the row is hovered, so even a
 *     correctly-rendered cancel was unreachable by keyboard and easy to miss.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../frontend/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

/* ---------- mirror of MessageRow's grouping predicate ---------- */

const actorKey = (type: string, d: Record<string, unknown>): string =>
  d.actor
    ? `sub:${String(d.actor)}`
    : type === "tool_call" || type === "tool_result"
      ? "agent-tools"
      : type === "prompt"
        ? `src:${String(d.source ?? "user")}`
        : `type:${type}`;

const authorOf = (type: string, d: Record<string, unknown>): string =>
  type === "prompt" && d.source === "user" ? "you" : type === "message" ? "agent" : "harness";

/** the predicate AS IT MUST BE after the fix */
function groupedAfterFix(
  prev: { type: string; data: Record<string, unknown> } | undefined,
  e: { type: string; data: Record<string, unknown> },
): boolean {
  return !!(
    prev &&
    !e.data.pending &&
    !prev.data.pending &&
    !e.data.cancelled &&
    actorKey(prev.type, prev.data) === actorKey(e.type, e.data) &&
    authorOf(prev.type, prev.data) === authorOf(e.type, e.data)
  );
}

const SENT = { type: "prompt", data: { source: "user", promptId: "u1" } };
const PENDING = { type: "prompt", data: { source: "user", promptId: "u2", pending: true } };

/* ---------- THE regression ---------- */

test("a queued message following a sent one does NOT group (#49)", () => {
  // the exact sequence from the report
  assert.equal(
    groupedAfterFix(SENT, PENDING),
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
      groupedAfterFix(prev, PENDING),
      false,
      `a queued row must never group (prev was ${prev.type}) (#49)`,
    );
  }
});

test("an already-grouped sent row still groups with its neighbour (#49)", () => {
  // the fix must not disable grouping everywhere — consecutive SENT prompts
  // (e.g. after a reload) should still collapse as before
  assert.equal(
    groupedAfterFix(SENT, { type: "prompt", data: { source: "user", promptId: "u3" } }),
    true,
    "normal grouping of settled rows must be preserved (#49)",
  );
});

test("a withdrawn row does not group either (#49)", () => {
  assert.equal(
    groupedAfterFix(SENT, { type: "prompt", data: { source: "user", cancelled: true } }),
    false,
    "a withdrawn row keeps its own header (#49)",
  );
});

/* ---------- the affordance must not depend on hover ---------- */

test("the queued row's cancel button is visible without hover (#49)", () => {
  assert.match(
    css,
    /\.msg\.pending \.msg-head \.editbtn\s*\{[^}]*opacity:\s*1/,
    "a control that only appears on hover does not exist for a keyboard user (#49)",
  );
});

test("edit buttons are focusable and become visible on focus (#49)", () => {
  assert.match(
    css,
    /\.msg-head \.editbtn:focus-visible\s*\{[^}]*opacity:\s*1/,
    "focus must reveal the affordance (#49)",
  );
});

/* ---------- wiring ---------- */

test("App.tsx guards the grouping predicate on pending/cancelled (#49)", () => {
  const i = app.indexOf("const grouped =");
  assert.ok(i > 0, "grouping predicate not found");
  const block = app.slice(i, i + 520);
  assert.match(block, /!e\.data\?\.pending/, "the pending row must be excluded (#49)");
  assert.match(block, /!props\.prev\.data\?\.pending/, "a pending predecessor must break the group (#49)");
  assert.match(block, /!e\.data\?\.cancelled/, "a withdrawn row must be excluded (#49)");
});

test("the cancel button lives inside the header the group flag controls (#49)", () => {
  // documents WHY the guard is required: if the button ever moves out of
  // msg-head, this assertion should be revisited
  const headStart = app.indexOf('<Show when={!grouped}>');
  const headEnd = app.indexOf("</Show>", app.indexOf("props.onCancel", headStart));
  assert.ok(headStart > 0 && headEnd > headStart, "msg-head block not found");
  assert.ok(
    app.slice(headStart, headEnd).includes("props.onCancel"),
    "✕ cancel is inside the !grouped header — that is the coupling (#49)",
  );
});