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

/**
 * #75 — this file re-implemented MessageRow's grouping predicate locally, and
 * asserted against ITS OWN copy. The comment even said "the predicate AS IT
 * MUST BE after the fix", which is an aspiration rather than the code.
 *
 * Deleting the real #49 fix left all four behavioural tests here PASSING,
 * because the local mirror still had the fix in it.
 *
 * The predicate now lives in `frontend/row-grouping.ts` — the module the
 * component itself calls — so these tests drive the code that runs.
 */
import { groupedWith, actorKeyOf, authorOf as groupedAuthorOf } from "../frontend/row-grouping.ts";

const SENT = { type: "prompt", data: { source: "user", promptId: "u1" } };
const PENDING = { type: "prompt", data: { source: "user", promptId: "u2", pending: true } };

/* ---------- THE regression ---------- */

test("a queued message following a sent one does NOT group (#49)", () => {
  // the exact sequence from the report
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
  // the fix must not disable grouping everywhere — consecutive SENT prompts
  // (e.g. after a reload) should still collapse as before
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

test("the SHIPPED predicate excludes pending and cancelled rows (#49)", () => {
  // #75: this used to grep App.tsx for the guard. The predicate has since moved
  // to frontend/row-grouping.ts, so grepping the component was checking that a
  // string still lived in a particular file rather than that the rule holds.
  //
  // The behavioural tests above now drive the real module, so this one only has
  // to assert that the COMPONENT still calls it — otherwise the extraction could
  // silently stop being used and the tests would keep passing against a module
  // nothing imports.
  assert.match(
    app,
    /groupedWith\(props\.prev/,
    "MessageRow must call the shared predicate (#49/#75)",
  );
  const src = readFileSync(new URL("../frontend/row-grouping.ts", import.meta.url), "utf8");
  assert.match(src, /!e\.data\?\.pending/, "the pending row must be excluded (#49)");
  assert.match(src, /!prev\.data\?\.pending/, "a pending predecessor must break the group (#49)");
  assert.match(src, /!e\.data\?\.cancelled/, "a withdrawn row must be excluded (#49)");
});

test("the shared predicate is imported, not re-declared in App.tsx (#75)", () => {
  assert.match(app, /from "\.\/row-grouping"/, "the import must exist (#75)");
  assert.doesNotMatch(
    app,
    /const actorKey = \(ev/,
    "the local copy must be gone, or it can drift again (#75)",
  );
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