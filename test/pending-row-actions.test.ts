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
const _css = readFileSync(new URL("../frontend/app.css", import.meta.url), "utf8");

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
import { groupedWith } from "../frontend/lib/row-grouping.ts";

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
